import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askJev, decisionConfiguration } from "../src/router.mjs";
import { main } from "../src/cli.mjs";
import { createTurnRouter, routerId } from "../src/native-router.mjs";

const env = {
  JEV_PROVIDER: "azure",
  AZURE_DECISION_ENDPOINT: "https://fixture.services.ai.azure.com/providers/microsoft/v1/systemone",
  AZURE_DECISION_API_KEY: "azure-fixture-only",
  AZURE_DECISION_MODEL: "Decision-1",
  JEV_API_KEY: "typesafe-fixture-only",
};
const models = [{ id: "cheap", name: "Cheap", context: "default", estimatedUsd: 0.002 }];
const args = { prompt: "Calculate 2+2", models, estimates: { inputTokens: 10000, outputTokens: 2000 }, env };
const answer = { answers: { model: { choice: "cheap", confidence: 0.98 } } };

test("Azure uses the exact systemone endpoint, api-key and deployment while preserving typed choice requests", async () => {
  let calls = 0;
  const selected = await askJev({
    ...args, apiKey: "must-not-be-used",
    client: { systemOne: assert.fail },
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, env.AZURE_DECISION_ENDPOINT);
      assert.equal(options.headers["api-key"], env.AZURE_DECISION_API_KEY);
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.redirect, "error");
      assert.equal(options.method, "POST");
      assert.ok(options.signal instanceof AbortSignal);
      const body = JSON.parse(options.body);
      assert.equal(body.model, "Decision-1");
      assert.equal(body.questions.model.type, "choice");
      assert.deepEqual(Object.keys(body.questions.model.criteria), ["cheap"]);
      assert.equal(body.state.request, args.prompt);
      assert.equal(options.body.includes(env.AZURE_DECISION_API_KEY), false);
      assert.equal(options.body.includes(env.JEV_API_KEY), false);
      return { ok: true, json: async () => answer };
    },
  });
  assert.equal(calls, 1);
  assert.equal(selected.id, "cheap");
  assert.equal(selected.reason, "azure-decision");
  assert.equal(selected.confidence, 0.98);
});

test("Azure accepts explicit chosen-label probabilities but rejects unavailable, malformed and low-confidence answers", async () => {
  const send = (model) => askJev({ ...args, fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { model } }) }) });
  assert.equal((await send({ choice: "cheap", probabilities: { cheap: 0.9 } })).confidence, 0.9);
  for (const model of [
    { choice: "unknown", confidence: 1 }, { choice: "cheap" },
    { choice: "cheap", confidence: "0.9" }, { choice: "cheap", confidence: 1.1 },
    { choice: "cheap", confidence: 0.29 },
  ]) await assert.rejects(send(model), /invalid|below/);
});

test("Azure transport errors do not expose response bodies or retry and cancellation prevents requests", async () => {
  let calls = 0;
  await assert.rejects(askJev({
    ...args, fetchImpl: async () => {
      calls++;
      return { ok: false, status: 429, json: assert.fail };
    },
  }), { message: "Azure Decision-1 request failed (HTTP 429)." });
  assert.equal(calls, 1);
  await assert.rejects(askJev({
    ...args, fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError(env.AZURE_DECISION_API_KEY); } }),
  }), { message: "Azure Decision-1 returned invalid JSON." });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(askJev({ ...args, signal: controller.signal, fetchImpl: assert.fail }), /abort/i);
});

test("backend selection is explicit, validates HTTPS and never borrows another backend's credential", async () => {
  assert.equal(decisionConfiguration({ JEV_API_KEY: "test-key" }).provider, "typesafe");
  assert.throws(() => decisionConfiguration({ JEV_PROVIDER: "invalid" }), /JEV_PROVIDER/);
  for (const endpoint of [
    "http://fixture.services.ai.azure.com/providers/microsoft/v1/systemone",
    "https://user:pass@fixture.services.ai.azure.com/providers/microsoft/v1/systemone",
    "https://fixture.services.ai.azure.com/v1/chat/completions",
  ]) assert.throws(() => decisionConfiguration({ ...env, AZURE_DECISION_ENDPOINT: endpoint }), /HTTPS/);
  await assert.rejects(askJev({ ...args, env: { ...env, AZURE_DECISION_API_KEY: "" }, fetchImpl: assert.fail }), /AZURE_DECISION_API_KEY/);
  const result = await askJev({
    ...args, env: { ...env, JEV_PROVIDER: "typesafe" }, fetchImpl: assert.fail,
    client: { systemOne: async () => answer },
  });
  assert.equal(result.reason, "jev");
});

test("startup CLI routes with Azure-only credentials, without requiring a TypeSafe key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-azure-cli-"));
  t.after(() => rm(directory, { recursive: true }));
  await writeFile(join(directory, ".env"), Object.entries({
    ...env, JEV_API_KEY: "", TYPESAFE_API_KEY: "", COPILOT_CLI_PATH: process.execPath,
  }).map(([key, value]) => `${key}=${value}`).join("\n"));
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(line));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers["api-key"], env.AZURE_DECISION_API_KEY);
    return { ok: true, json: async () => answer };
  });

  const code = await main(["route", "Calculate 2+2", "-C", directory, "--json"], {
    discoverModels: async () => [{
      id: "cheap", name: "Cheap",
      billing: { tokenPrices: { inputPrice: 10, outputPrice: 50, batchSize: 1000000 } },
    }],
    jevClient: { systemOne: assert.fail }, launchCopilot: assert.fail,
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(logs[0]).decision.reason, "azure-decision");
});

test("native picker Azure routing stays pinned for a turn and bypasses classification for manual models", async (t) => {
  let current = routerId;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return { ok: true, json: async () => answer };
  });
  const turns = createTurnRouter({
    env, log: async () => {},
    session: { rpc: { model: {
      getCurrent: async () => ({ modelId: current }),
      list: async () => ({ list: [{
        id: "cheap", provider: { kind: "copilot" }, supported_endpoints: ["/responses"],
        billing: { tokenPrices: { inputPrice: 10, outputPrice: 50, batchSize: 1000000 } },
      }] }),
    } } },
  });
  await turns.submitted("Calculate 2+2");
  const first = turns.current();
  assert.equal(first.decision.reason, "azure-decision");
  assert.strictEqual(turns.current(), first);
  assert.equal(calls, 1);
  await turns.submitted("Calculate 3+3");
  assert.equal(calls, 2);
  current = "cheap";
  await turns.submitted("A manual-model task");
  assert.equal(calls, 2);
});
