import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pricedModels } from "../src/catalog.mjs";
import { copilotEnvironment, executablePath, loadEnvironment, positiveInteger, safeError } from "../src/config.mjs";
import { launchCopilot, main, nativeArguments, parseArguments } from "../src/cli.mjs";
import { askJev, selectModel } from "../src/router.mjs";

const estimates = { inputTokens: 10000, outputTokens: 2000, context: "default" };
function model(id, inputPrice = 10, outputPrice = 50, extra = {}) {
  return {
    id, name: id,
    policy: { state: "enabled" },
    capabilities: { limits: { max_context_window_tokens: 1000000, max_prompt_tokens: 872000, max_output_tokens: 128000 } },
    billing: {
      tokenPrices: {
        inputPrice, outputPrice, cacheReadPrice: 1, cacheWritePrice: 12.5,
        batchSize: 1000000, maxPromptTokens: 272000,
        longContext: { inputPrice: inputPrice * 2, outputPrice: outputPrice * 1.5, maxPromptTokens: 872000 },
      },
    },
    ...extra,
  };
}
const catalog = [model("strong", 200, 1000), model("cheap")];
const candidates = pricedModels(catalog, estimates);
const jevClient = (id = "cheap", confidence = 1) => ({
  systemOne: async () => ({ answers: { model: { choice: id, confidence } } }),
});

test("live prices use AI credits per batch, not USD or premium-request multipliers", () => {
  const [entry] = pricedModels([model("cheap")], estimates);
  assert.equal(entry.inputUsdPerMillion, 0.1);
  assert.equal(entry.outputUsdPerMillion, 0.5);
  assert.equal(entry.cacheReadUsdPerMillion, 0.01);
  assert.equal(entry.cacheWriteUsdPerMillion, 0.125);
  assert.equal(entry.estimatedUsd, 0.002);
  assert.equal(pricedModels([model("small-batch", 1, 5, {
    billing: { multiplier: 999, tokenPrices: { inputPrice: 1, outputPrice: 5, batchSize: 100000 } },
  })], estimates)[0].estimatedUsd, 0.002);
});

test("catalog sorts by estimated cost and excludes disabled, unconfigured, auto and unknown prices", () => {
  assert.deepEqual(pricedModels([
    ...catalog, model("disabled", 0, 0, { policy: { state: "disabled" } }),
    model("unconfigured", 0, 0, { policy: { state: "unconfigured" } }),
    model("auto"), model("unknown", 0, 0, { billing: {} }),
  ], estimates).map((entry) => entry.id), ["cheap", "strong"]);
});

test("catalog accepts absent policy, free prices and cache prices of zero", () => {
  const free = model("free", 0, 0, { policy: undefined });
  free.billing.tokenPrices.cacheReadPrice = 0;
  free.billing.tokenPrices.cacheWritePrice = 0;
  const [entry] = pricedModels([free], estimates);
  assert.equal(entry.estimatedUsd, 0);
  assert.equal(entry.cacheReadUsdPerMillion, 0);
  assert.equal(entry.cacheWriteUsdPerMillion, 0);
});

test("invalid price metadata is not silently treated as free", () => {
  for (const bad of [-1, NaN, Infinity, undefined, "10"]) {
    const entry = model("bad");
    entry.billing.tokenPrices.inputPrice = bad;
    assert.equal(pricedModels([entry], estimates).length, 0);
  }
  for (const bad of [0, -1, NaN, undefined]) {
    const entry = model("bad");
    entry.billing.tokenPrices.batchSize = bad;
    assert.equal(pricedModels([entry], estimates).length, 0);
  }
});

test("default threshold is inclusive and long-context prices require explicit context", () => {
  assert.equal(pricedModels([model("a")], { ...estimates, inputTokens: 272000 }).length, 1);
  assert.equal(pricedModels([model("a")], { ...estimates, inputTokens: 272001 }).length, 0);
  const [long] = pricedModels([model("a")], { ...estimates, inputTokens: 272001, context: "long_context" });
  assert.equal(long.inputUsdPerMillion, 0.2);
  assert.equal(long.outputUsdPerMillion, 0.75);
  assert.equal(long.estimatedUsd, (272001 * 20 + 2000 * 75) / 1000000 / 100);
  assert.equal(pricedModels([model("a", 10, 50, {
    billing: { tokenPrices: { inputPrice: 10, outputPrice: 50, batchSize: 1000000 } },
  })], { ...estimates, context: "long_context" }).length, 0);
});

test("model context and output limits are enforced", () => {
  const small = model("small", 10, 50, {
    capabilities: { limits: { max_context_window_tokens: 11000, max_output_tokens: 1000 } },
  });
  assert.equal(pricedModels([small], estimates).length, 0);
  assert.equal(pricedModels([small], { ...estimates, outputTokens: 1000 }).length, 1);
  assert.equal(pricedModels([small], { ...estimates, inputTokens: 11000, outputTokens: 1 }).length, 0);
  const tighterPrompt = model("tighter", 10, 50, {
    capabilities: { limits: { max_context_window_tokens: 500000, max_prompt_tokens: 372000, max_output_tokens: 128000 } },
  });
  assert.equal(pricedModels([tighterPrompt], {
    ...estimates, inputTokens: 372001, context: "long_context",
  }).length, 0);
  assert.equal(pricedModels([tighterPrompt], {
    ...estimates, inputTokens: 372000, context: "long_context",
  }).length, 1);
});

test("JEV receives only the task, candidate metadata and estimates, with a hard deadline", async () => {
  let request;
  const result = await askJev({
    prompt: "Format a file", models: candidates, estimates, apiKey: "test-only",
    client: {
      async systemOne(body, options) {
        request = body;
        assert.ok(options.signal instanceof AbortSignal);
        return { answers: { model: { choice: "cheap", confidence: 0.99 } } };
      },
    },
  });
  assert.equal(result.id, "cheap");
  assert.equal(result.reason, "jev");
  assert.deepEqual(Object.keys(request.state), ["request", "token_estimates", "available_models"]);
  assert.deepEqual(Object.keys(request.questions.model.criteria), ["cheap", "strong"]);
  assert.equal(JSON.stringify(request).includes("test-only"), false);
});

test("JEV invalid, unavailable and low-confidence choices fail closed", async () => {
  for (const [id, confidence] of [["missing", 1], ["cheap", -1], ["cheap", 1.01], ["cheap", NaN], ["cheap", 0.29]]) {
    await assert.rejects(askJev({
      prompt: "task", models: candidates, estimates, apiKey: "test-only",
      client: jevClient(id, confidence),
    }));
  }
  await assert.rejects(askJev({ prompt: "task", models: candidates, estimates }), /JEV_API_KEY/);
});

test("manual model skips JEV but still enforces the account catalog and price/context", async () => {
  const args = { catalog, candidates, estimates, env: {}, warn: assert.fail };
  const selected = await selectModel({
    ...args, model: "strong", client: { systemOne: assert.fail },
  });
  assert.equal(selected.reason, "manual");
  assert.equal(selected.id, "strong");
  await assert.rejects(selectModel({ ...args, model: "invented" }), /not enabled/);
  await assert.rejects(selectModel({ ...args, candidates: [], model: "cheap" }), /no valid price/);
});

test("JEV failures block execution unless the cheapest fallback is explicitly enabled", async () => {
  const warnings = [];
  const args = {
    catalog, candidates, estimates, prompt: "task",
    env: { JEV_API_KEY: "test-only" },
    warn: (message) => warnings.push(message),
    client: { systemOne: async () => { throw new Error("service unavailable test-only"); } },
  };
  await assert.rejects(selectModel(args), /service unavailable/);
  assert.equal(warnings.length, 0);
  const result = await selectModel({ ...args, env: { ...args.env, JEV_FALLBACK_CHEAPEST: "1" } });
  assert.equal(result.id, "cheap");
  assert.equal(result.reason, "explicit-cheapest-fallback");
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("[REDACTED]"));
  assert.equal(warnings[0].includes("test-only"), false);
});

test("empty candidates fail even when cheapest fallback is enabled", async () => {
  await assert.rejects(selectModel({
    catalog: [], candidates: [], env: { JEV_FALLBACK_CHEAPEST: "1" }, warn: assert.fail,
  }), /No enabled models/);
});

test("parser preserves the task and native flags without adding permissions", () => {
  const options = parseArguments(["-p", "task; $(not-a-command)", "--", "--deny-tool=shell", "--silent"]);
  assert.deepEqual(nativeArguments(options, { id: "cheap" }), [
    "--model", "cheap", "--context", "default", "-p", "task; $(not-a-command)",
    "--deny-tool=shell", "--silent",
  ]);
  assert.deepEqual(nativeArguments(parseArguments(["hello", "world"]), { id: "cheap" }), [
    "--model", "cheap", "--context", "default", "-i", "hello world",
  ]);
});

test("parser handles routes, manual overrides and explicit long context", () => {
  const options = parseArguments(["route", "task", "--model=cheap", "--input-tokens", "300000", "--context=long_context", "--json"]);
  assert.equal(options.command, "route");
  assert.equal(options.model, "cheap");
  assert.equal(options.context, "long_context");
  assert.equal(options.inputTokens, "300000");
  assert.equal(options.json, true);
  assert.equal(parseArguments(["--dry-run", "task"]).command, "route");
  assert.equal(parseArguments(["models", "--json"]).command, "models");
});

test("parser rejects ambiguous or bypassing flags", () => {
  for (const args of [
    ["-p"], ["-p", ""], ["--model"], ["-p", "a", "-i", "b"], ["-p", "a", "b"],
    ["--model", "a", "--model", "b"], ["--context=wrong"], ["--unknown"], ["--json", "task"],
    ["models", "task"], ["route", "task", "--", "--silent"],
    ["task", "--", "--model=expensive"], ["task", "--", "--context", "long_context"],
    ["task", "--", "-p", "different"], ["task", "--", "-idifferent"],
    ["task", "--", "--agent", "different"], ["task", "--", "--fleet"], ["task", "--", "-Celsewhere"],
  ]) assert.throws(() => parseArguments(args), undefined, JSON.stringify(args));
});

test("positive estimates reject NaN, zero, negative, unsafe and malformed values", () => {
  assert.equal(positiveInteger("10000", "tokens"), 10000);
  for (const value of ["0", "-1", "NaN", "1.2", "Infinity", "1e6", "100oops", "9007199254740992"]) {
    assert.throws(() => positiveInteger(value, "tokens"), /positive safe integer/);
  }
});

test("environment precedence is process > target project > launcher .env", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-copilot-test-"));
  t.after(() => rm(directory, { recursive: true }));
  await writeFile(join(directory, ".env"), "JEV_API_KEY=project-test-key\nLOCAL_TEST=yes\nJEV_INPUT_TOKENS=500\n");
  const env = await loadEnvironment(directory, { JEV_API_KEY: "process-test-key" });
  assert.equal(env.JEV_API_KEY, "process-test-key");
  assert.equal(env.JEV_INPUT_TOKENS, "500");
  assert.equal(env.LOCAL_TEST, "yes");
});

test("JEV keys and TypeSafe settings never reach the native Copilot child", () => {
  assert.deepEqual(copilotEnvironment({
    PATH: "/bin", GITHUB_TOKEN: "test-github", JEV_API_KEY: "test-jev",
    TYPESAFE_API_KEY: "test-typesafe", TYPESAFE_BASE_URL: "https://example.invalid",
  }), { PATH: "/bin", GITHUB_TOKEN: "test-github" });
  assert.equal(safeError(new Error("bad test-key apikey_abc_def"), { JEV_API_KEY: "test-key" }),
    "bad [REDACTED] [REDACTED]");
});

test("native execution inherits cwd, strips JEV secrets and preserves the exit code", async () => {
  const exit = await launchCopilot(process.execPath, ["--input-type=module", "-e", `
    if (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY) process.exit(99);
    if (process.cwd() !== ${JSON.stringify(process.cwd())}) process.exit(98);
    process.exit(7);
  `], { cwd: process.cwd(), env: { ...process.env, JEV_API_KEY: "test-key", TYPESAFE_API_KEY: "test-key" } });
  assert.equal(exit, 7);
});

test("executable resolution supports PATH, absolute paths and actionable failures", async () => {
  assert.equal(await executablePath(process.execPath, {}, process.cwd()), process.execPath);
  await assert.rejects(executablePath("missing-copilot-executable", { PATH: "/nonexistent" }, process.cwd()), /not found/);
  await assert.rejects(launchCopilot("/nonexistent/copilot", [], { cwd: process.cwd(), env: {} }), /ENOENT/);
});

test("full CLI routes without launching, then launches the selected exact native model", async (t) => {
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  t.mock.method(console, "error", () => {});
  const oldPath = process.env.COPILOT_CLI_PATH;
  const oldKey = process.env.JEV_API_KEY;
  process.env.COPILOT_CLI_PATH = process.execPath;
  process.env.JEV_API_KEY = "test-key";
  t.after(() => {
    if (oldPath === undefined) delete process.env.COPILOT_CLI_PATH;
    else process.env.COPILOT_CLI_PATH = oldPath;
    if (oldKey === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = oldKey;
  });
  const dependencies = {
    discoverModels: async () => catalog,
    jevClient: jevClient(),
    launchCopilot: assert.fail,
  };
  assert.equal(await main(["route", "test task", "--json"], dependencies), 0);
  const output = JSON.parse(logs[0]);
  assert.equal(output.decision.id, "cheap");
  assert.equal(output.executed, false);
  assert.equal(JSON.stringify(output).includes("test-key"), false);
  let launched;
  assert.equal(await main(["-p", "test task", "--", "--silent"], {
    ...dependencies,
    launchCopilot: async (executable, args) => { launched = { executable, args }; return 7; },
  }), 7);
  assert.equal(launched.executable, process.execPath);
  assert.deepEqual(launched.args, ["--model", "cheap", "--context", "default", "-p", "test task", "--silent"]);
  assert.equal(await main(["--help"], { discoverModels: assert.fail }), 0);
  assert.equal(await main(["route"], { discoverModels: assert.fail }), 1);
  let routerLaunch;
  assert.equal(await main(["router", "--", "--deny-tool=shell"], {
    discoverModels: assert.fail,
    launchCopilot: async (executable, args, options) => {
      routerLaunch = { executable, args, options };
      return 0;
    },
  }), 0);
  assert.deepEqual(routerLaunch.args, ["--experimental", "--deny-tool=shell"]);
  assert.equal(routerLaunch.options.env.COPILOT_ALLOW_GET_PROVIDER_ENDPOINT, "true");
  assert.equal(await main(["router", "task"], { launchCopilot: assert.fail }), 1);
});
