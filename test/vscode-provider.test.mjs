import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: ["vscode/src/extension.ts"], bundle: true, platform: "node",
  format: "cjs", target: "node22", write: false,
  external: ["vscode", "@typesafe-ai/sdk"],
});

async function harness(t, providerName = "typesafe", legacySetting = false) {
  const directory = await mkdtemp(join(tmpdir(), "jev-editor-test-"));
  t.after(() => rm(directory, { recursive: true }));
  const envFile = join(directory, ".env");
  await writeFile(envFile, `JEV_PROVIDER=${providerName}\nJEV_API_KEY=fixture-secret-key\nJEV_INPUT_TOKENS=10000\n` +
    "AZURE_DECISION_ENDPOINT=https://fixture.services.ai.azure.com/providers/microsoft/v1/systemone\nAZURE_DECISION_API_KEY=azure-fixture-key\nAZURE_DECISION_MODEL=Decision-1\n");
  class TextPart { constructor(value) { this.value = value; } }
  class ToolCallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
  class ToolResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
  class DataPart {}
  class Message { constructor(role, content, name) { Object.assign(this, { role, content, name }); } }
  class CancellationError extends Error {}
  class EventEmitter { event = () => {}; fire() {} dispose() {} }
  const decisions = [];
  const requests = [];
  const logs = [];
  let summarizations = 0;
  const target = {
    id: "opaque-cheap", vendor: "copilot", family: "gpt-6-luna", name: "GPT-6 Luna",
    maxInputTokens: 128000,
    countTokens: async () => 10,
    async sendRequest(messages, options) {
      requests.push({ model: this.id, messages, options });
      return { stream: (async function* () {
        yield new TextPart("hello");
        if (requests.length === 1) yield new ToolCallPart("call-unique", "testTool", { value: 1 });
      })() };
    },
  };
  const mockVscode = {
    LanguageModelTextPart: TextPart, LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart, LanguageModelDataPart: DataPart,
    LanguageModelChatMessage: Message, LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
    CancellationError, EventEmitter,
    workspace: { getConfiguration: (section) => ({
      get: () => legacySetting && section === "desicionRouter" ? "" : envFile,
    }) },
    window: { showInputBox: async () => { summarizations++; return "Summarized task"; } },
    lm: { selectChatModels: async () => [
      target,
      { ...target, id: "opaque-expensive", family: "gpt-6-sol", name: "GPT-6 Sol" },
      { ...target, id: "unknown", family: "unpriced", name: "unpriced" },
      { ...target, id: "non-copilot", vendor: "other" },
      { ...target, id: "auto", family: "auto" },
    ] },
  };
  const sdk = {
    choice: (instructions, criteria) => ({ type: "choice", instructions, criteria }),
    TypeSafeClient: class {
      async systemOne(request) {
        assert.equal(providerName, "typesafe", "Azure must not call the TypeSafe backend");
        decisions.push(request);
        return { answers: { model: { choice: request.state.available_models[0].id, confidence: 0.95 } } };
      }
    },
  };
  const module = { exports: {} };
  runInNewContext(bundled.outputFiles[0].text, {
    module, exports: module.exports,
    require: (name) => name === "vscode" ? mockVscode : name === "@typesafe-ai/sdk" ? sdk : require(name),
    __JEV_DEFAULT_ENV_FILE__: envFile,
    process: { env: {} }, Buffer, AbortController, AbortSignal, Error, URL,
    fetch: async (url, options) => {
      if (url.endsWith("/systemone")) {
        assert.equal(options.headers["api-key"], "azure-fixture-key");
        const request = JSON.parse(options.body);
        assert.equal(request.model, "Decision-1");
        decisions.push(request);
        return { ok: true, json: async () => ({
          answers: { model: { choice: request.state.available_models[0].id, confidence: 0.95 } },
        }) };
      }
      return {
        ok: true,
        text: async () => "Prices per 1 million tokens\n| Model | Input | Output |\n| --- | --- | --- |\n| GPT-6 Luna | $0.10 | $0.50 |\n| GPT-6 Sol | $1.00 | $5.00 |",
      };
    },
  });
  const provider = new module.exports.JevProvider({ appendLine: (line) => logs.push(line) });
  t.after(() => provider.dispose());
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const model = provider.provideLanguageModelChatInformation()[0];
  return { provider, token, model, TextPart, ToolResultPart, CancellationError, decisions, requests, logs, summarizations: () => summarizations };
}

test("editor routing uses its account models, preserves tools/context, and pins native tool continuations", async (t) => {
  const h = await harness(t);
  const user = { role: 1, content: [new h.TextPart("<context>PRIVATE_REPOSITORY_TEXT</context><userRequest>Say hello</userRequest>")] };
  const progress = { report() {} };
  const options = { tools: [{ name: "testTool", inputSchema: { type: "object" } }], toolMode: 1 };
  await h.provider.provideLanguageModelChatResponse(h.model, [user], options, progress, h.token);
  assert.equal(h.decisions.length, 1);
  assert.equal(h.decisions[0].state.request, "Say hello");
  assert.deepEqual(Array.from(h.decisions[0].state.available_models, ({ id }) => id), ["opaque-cheap", "opaque-expensive"]);
  assert.equal(h.decisions[0].state.available_models[0].estimatedUsd, 0.002);
  assert.equal(h.requests[0].model, "opaque-cheap");
  assert.equal(h.requests[0].messages[0].content[0].value, user.content[0].value);
  assert.equal(h.requests[0].options.tools.length, options.tools.length);
  assert.equal(h.requests[0].options.tools[0], options.tools[0]);
  const result = { role: 1, content: [new h.ToolResultPart("call-unique", [new h.TextPart("tool completed")])] };
  await h.provider.provideLanguageModelChatResponse(h.model, [user, result], options, progress, h.token);
  assert.equal(h.decisions.length, 1);
  assert.equal(h.requests.length, 2);
  await h.provider.provideLanguageModelChatResponse(h.model, [user, result, user], options, progress, h.token);
  assert.equal(h.decisions.length, 2, "a new user turn gets a fresh decision, even if its text repeats");
  assert.equal(h.summarizations(), 0);
  assert.ok(h.logs.every((line) => !line.includes("PRIVATE") && !line.includes("fixture-secret-key")));
});

test("unwrapped editor context requires a user summary; unknown parts, secrets and orphan tool results fail closed", async (t) => {
  const h = await harness(t);
  const progress = { report() {} };
  const user = { role: 1, content: [new h.TextPart("PRIVATE_UNWRAPPED_EDITOR_CONTEXT")] };
  await h.provider.provideLanguageModelChatResponse(h.model, [user], {}, progress, h.token);
  assert.equal(h.summarizations(), 1);
  assert.equal(h.decisions[0].state.request, "Summarized task");
  await assert.rejects(h.provider.provideLanguageModelChatResponse(
    h.model, [{ role: 1, content: [{}] }], {}, progress, h.token), /unsupported message part/);
  await assert.rejects(h.provider.provideLanguageModelChatResponse(
    h.model, [{ role: 1, content: [new h.ToolResultPart("another-conversation", [])] }], {}, progress, h.token), /route is unavailable/);
  await assert.rejects(h.provider.provideLanguageModelChatResponse(
    h.model, [{ role: 1, content: [new h.TextPart("<userRequest>fixture-secret-key</userRequest>")] }], {}, progress, h.token), /contains a credential/);
  assert.equal(h.decisions.length, 1);
  assert.equal(h.requests.length, 1);
});

test("editor cancellation blocks routing and inference", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.provider.provideLanguageModelChatResponse(
    h.model, [], {}, { report() {} }, { ...h.token, isCancellationRequested: true }), h.CancellationError);
  assert.equal(h.decisions.length, 0);
  assert.equal(h.requests.length, 0);
});

test("editor Azure routing delegates to native Copilot and reuses the decision for tool results", async (t) => {
  const h = await harness(t, "azure");
  const user = { role: 1, content: [new h.TextPart("<userRequest>Say hello</userRequest>")] };
  const progress = { report() {} };
  await h.provider.provideLanguageModelChatResponse(h.model, [user], {}, progress, h.token);
  assert.equal(h.decisions.length, 1);
  assert.equal(h.requests[0].model, "opaque-cheap");
  assert.ok(h.logs[0].includes("azure-decision"));
  const result = { role: 1, content: [new h.ToolResultPart("call-unique", [])] };
  await h.provider.provideLanguageModelChatResponse(h.model, [user, result], {}, progress, h.token);
  assert.equal(h.decisions.length, 1);
  assert.equal(h.requests.length, 2);
  assert.ok(h.logs.every((line) => !line.includes("azure-fixture-key")));
});

test("renamed editor model preserves the previous envFile configuration", async (t) => {
  const h = await harness(t, "azure", true);
  assert.equal(h.model.id, "desicion-router");
  assert.equal(h.model.name, "desicion-router");
  await h.provider.provideLanguageModelChatResponse(h.model, [{
    role: 1, content: [new h.TextPart("<userRequest>Say hello</userRequest>")],
  }], {}, { report() {} }, h.token);
  assert.equal(h.decisions.length, 1);
  assert.equal(h.requests[0].model, "opaque-cheap");
});
