import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCatalogModel, pricedModels } from "../src/catalog.mjs";
import { createTurnRouter, registration, rewriteRequest, routerId, startProxy } from "../src/native-router.mjs";

const rawModel = {
  id: "cheap", name: "Cheap", provider: { kind: "copilot" }, policy: { state: "enabled" },
  supported_endpoints: ["/responses"],
  capabilities: { supports: { reasoning_effort: ["none", "low"] }, limits: {
    max_prompt_tokens: 272000, max_output_tokens: 64000, max_context_window_tokens: 400000,
  } },
  billing: { token_prices: {
    batch_size: 1000000,
    default: { input_price: 10, output_price: 50, cache_read_price: 1, cache_write_price: 12.5, max_prompt_tokens: 272000 },
    long_context: { input_price: 20, output_price: 75, max_prompt_tokens: 300000 },
  } },
};
const env = { JEV_API_KEY: "test-jev-key" };

function mockSession() {
  let current = routerId;
  return {
    manual() { current = "cheap"; },
    automatic() { current = routerId; },
    rpc: {
      model: {
        getCurrent: async () => ({ modelId: current, contextTier: "default" }),
        list: async () => ({ list: [
          rawModel,
          { ...rawModel, id: "other-provider", provider: { kind: "byok" } },
          { ...rawModel, id: "not-responses", supported_endpoints: ["/v1/messages"] },
        ] }),
      },
      provider: {
        getEndpoint: async ({ modelId }) => {
          assert.equal(modelId, "cheap");
          return {
            type: "openai", wireApi: "responses", baseUrl: "https://api.example.test/v1",
            apiKey: "test-github-credential", headers: { "Copilot-Integration-Id": "test" },
            sessionToken: { header: "Copilot-Session-Token", token: "test-runtime-token", model: "cheap" },
          };
        },
      },
    },
  };
}

test("raw session catalog and normalized SDK catalog use identical pricing units", () => {
  const normalized = normalizeCatalogModel(rawModel);
  assert.equal(normalized.capabilities.supports.reasoningEffort, true);
  const estimates = { inputTokens: 10000, outputTokens: 2000, context: "default" };
  assert.deepEqual(pricedModels([rawModel], estimates), pricedModels([normalized], estimates));
  assert.equal(pricedModels([rawModel], estimates)[0].estimatedUsd, 0.002);
  const long = pricedModels([rawModel], { ...estimates, context: "long_context" })[0];
  assert.equal(long.inputUsdPerMillion, 0.2);
  assert.equal(long.outputUsdPerMillion, 0.75);
  assert.equal(pricedModels([{ ...rawModel, model_picker_enabled: false }], estimates).length, 0);
});

test("registered model has the exact native display name and provider-qualified selection ID", () => {
  const entry = registration("http://127.0.0.1:9999/v1", "local-token");
  assert.equal(entry.models[0].name, "Desicion Router");
  assert.equal(`${entry.models[0].provider}/${entry.models[0].id}`, routerId);
  assert.equal(entry.providers[0].wireApi, "responses");
  assert.equal(entry.providers[0].apiKey, "local-token");
  assert.equal(JSON.stringify(entry).includes("test-jev-key"), false);
});

test("each new routed turn calls JEV once; tool continuations reuse the chosen model", async () => {
  const session = mockSession();
  const calls = [];
  const logs = [];
  const turns = createTurnRouter({
    session, env, log: async (message) => logs.push(message),
    jevClient: {
      systemOne: async (request) => {
        calls.push(request);
        return { answers: { model: { choice: "cheap", confidence: 0.98 } } };
      },
    },
  });
  assert.throws(() => turns.current(), /No routed user turn/);
  await turns.submitted("first task");
  const first = turns.current();
  assert.equal(first.decision.id, "cheap");
  assert.strictEqual(turns.current(), first);
  assert.strictEqual(turns.current(), first);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].questions.model.criteria), ["cheap"]);
  assert.equal(calls[0].state.request, "first task");
  await turns.submitted("second task");
  assert.equal(turns.current().sequence, 2);
  assert.equal(calls.length, 2);
  session.manual();
  await turns.submitted("manual task");
  assert.equal(calls.length, 2);
  session.automatic();
  await turns.submitted("back to routing");
  assert.equal(calls.length, 3);
  assert.equal(logs.length, 3);
});

test("routing errors are visible and block inference even if the host treats hooks as best effort", async () => {
  const messages = [];
  const turns = createTurnRouter({
    session: mockSession(), env, log: async (message) => messages.push(message),
    jevClient: { systemOne: async () => { throw new Error("bad test-jev-key"); } },
  });
  await turns.submitted("task");
  assert.throws(() => turns.current(), /bad \[REDACTED\]/);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].includes("test-jev-key"), false);
});

test("wire rewriting preserves all native tools, context and sampling parameters", () => {
  const body = {
    model: "desicion-router", input: [{ role: "user", content: "task" }, { type: "function_call_output", output: "done", call_id: "1" }],
    tools: [{ type: "function", name: "native_tool", parameters: { type: "object" } }],
    stream: true, max_output_tokens: 1000, reasoning: { effort: "low" },
  };
  const model = normalizeCatalogModel(rawModel);
  const rewritten = rewriteRequest(body, { id: "cheap" }, model);
  assert.equal(rewritten.model, "cheap");
  assert.strictEqual(rewritten.tools, body.tools);
  assert.strictEqual(rewritten.input, body.input);
  assert.deepEqual(rewritten.reasoning, { effort: "low" });
  assert.equal(body.model, "desicion-router");
  assert.equal(rewriteRequest(body, { id: "cheap" }, {
    capabilities: { supports: { reasoningEffort: false } },
  }).reasoning, undefined);
  assert.throws(() => rewriteRequest({ ...body, previous_response_id: "old" }, { id: "cheap" }, model), /Stateful/);
  assert.throws(() => rewriteRequest({ ...body, model: "invented" }, { id: "cheap" }, model), /Unknown/);
  assert.throws(() => rewriteRequest({ ...body, max_output_tokens: 64001 }, { id: "cheap" }, model), /output exceeds/);
});

test("loopback proxy authenticates, forwards SSE and uses only runtime GitHub credentials upstream", async (t) => {
  const sent = [];
  const messages = [];
  const turns = { current: () => ({ decision: { id: "cheap" }, model: normalizeCatalogModel(rawModel) }) };
  const proxy = await startProxy({
    session: mockSession(), env, turns, log: async (message) => messages.push(message),
    fetchImpl: async (url, options) => {
      sent.push({ url: url.href, options });
      return new Response('event: response.completed\ndata: {"response":{"model":"cheap"}}\n\n', {
        headers: { "content-type": "text/event-stream", "authorization": "not-for-downstream" },
      });
    },
  });
  t.after(() => proxy.close());
  const payload = { model: "desicion-router", input: "task", stream: true };
  const post = (authorization, body = JSON.stringify(payload)) => fetch(`${proxy.baseUrl}/responses`, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body,
  });
  assert.equal((await post("Bearer wrong")).status, 401);
  assert.equal(sent.length, 0);
  const result = await post(`Bearer ${proxy.apiKey}`);
  assert.equal(result.status, 200);
  assert.ok((await result.text()).includes("response.completed"));
  assert.equal(result.headers.has("authorization"), false);
  assert.equal(sent[0].url, "https://api.example.test/v1/responses");
  assert.equal(sent[0].options.headers.get("authorization"), "Bearer test-github-credential");
  assert.equal(sent[0].options.headers.get("Copilot-Session-Token"), "test-runtime-token");
  assert.notEqual(sent[0].options.headers.get("authorization"), `Bearer ${proxy.apiKey}`);
  assert.equal(JSON.parse(sent[0].options.body).model, "cheap");
  assert.equal(sent[0].options.body.includes("test-jev-key"), false);
  assert.equal(sent[0].options.redirect, "error");
  assert.equal(messages.length, 0);
  assert.equal((await post(`Bearer ${proxy.apiKey}`, "invalid-json")).status, 502);
  assert.equal(messages.length, 1);
});

test("proxy reports upstream HTTP failures without forwarding credential-bearing error bodies", async (t) => {
  const messages = [];
  const proxy = await startProxy({
    session: mockSession(), env,
    turns: { current: () => ({ decision: { id: "cheap" }, model: normalizeCatalogModel(rawModel) }) },
    log: async (message) => messages.push(message),
    fetchImpl: async () => new Response("test-github-credential", { status: 403 }),
  });
  t.after(() => proxy.close());
  const response = await fetch(`${proxy.baseUrl}/responses`, {
    method: "POST", headers: { authorization: `Bearer ${proxy.apiKey}` },
    body: JSON.stringify({ model: "desicion-router" }),
  });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.ok(text.includes("HTTP 403"));
  assert.equal(text.includes("test-github-credential"), false);
  assert.equal(messages.length, 1);
});

test("unsupported backend protocols, transport and insecure endpoints fail before sending credentials", async (t) => {
  for (const override of [
    { type: "anthropic" }, { wireApi: "completions" }, { transport: "websockets" },
    { baseUrl: "http://not-allowed.example" }, { sessionToken: { model: "different", token: "secret" } },
  ]) {
    const session = mockSession();
    const endpoint = await session.rpc.provider.getEndpoint({ modelId: "cheap" });
    session.rpc.provider.getEndpoint = async () => ({ ...endpoint, ...override });
    const proxy = await startProxy({
      session, env, log: async () => {},
      turns: { current: () => ({ decision: { id: "cheap" }, model: normalizeCatalogModel(rawModel) }) },
      fetchImpl: assert.fail,
    });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST", headers: { authorization: `Bearer ${proxy.apiKey}` },
        body: JSON.stringify({ model: "desicion-router" }),
      });
      assert.equal(response.status, 502);
      await response.body.cancel();
    } finally { await proxy.close(); }
  }
});
