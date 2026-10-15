import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { pricedModels } from "../src/catalog.mjs";
import { copilotEnvironment, executablePath, loadEnvironment } from "../src/config.mjs";
import { routerId } from "../src/native-router.mjs";

const cwd = await mkdtemp(join(tmpdir(), "jev-native-smoke-"));
const env = await loadEnvironment(cwd);
const executable = await executablePath(env.COPILOT_CLI_PATH || "copilot", env, cwd);
const client = new CopilotClient({
  connection: RuntimeConnection.forStdio({
    path: executable,
    env: { ...copilotEnvironment(env), COPILOT_ALLOW_GET_PROVIDER_ENDPOINT: "true" },
  }),
  logLevel: "error",
});
let session;
try {
  await client.start();
  const catalog = await client.listModels();
  const cheapest = pricedModels(catalog, { inputTokens: 10000, outputTokens: 2000, context: "default" })[0];
  assert.ok(cheapest);
  let toolCalls = 0;
  session = await client.createSession({
    model: cheapest.id, workingDirectory: cwd,
    enableExperimentalMode: true, requestExtensions: true, enableConfigDiscovery: true,
    availableTools: [],
    tools: [{
      name: "simulation_value", description: "Return the value 9 for the routing smoke test.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => { toolCalls++; return "9"; },
    }],
    disabledMcpServers: ["github-mcp-server", "playwright", "codingagent"],
    onPermissionRequest: async () => ({ kind: "approve-once", approvedInteractively: true }),
  });
  const decisions = [];
  session.on("session.info", (event) => {
    if (event.data.message?.startsWith("JEV ->")) decisions.push(event.data.message);
  });
  let picker;
  for (let attempt = 0; attempt < 40; attempt++) {
    picker = (await session.rpc.model.list()).list.find((model) => model.id === routerId);
    if (picker) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(picker?.name, "Decision Router");
  await session.setModel(routerId);
  const first = await session.sendAndWait({
    prompt: "Return only the result of 2 + 2. Do not use tools or read files.",
  }, 90000);
  assert.equal(first?.data.content.trim(), "4");
  assert.equal((await session.rpc.model.getCurrent()).modelId, routerId);
  assert.equal(decisions.length, 1);
  const second = await session.sendAndWait({
    prompt: "Call the simulation_value tool exactly once. Return only the value it returns. Do not use other tools.",
  }, 90000);
  assert.equal(second?.data.content.trim(), "9");
  assert.equal(toolCalls, 1);
  assert.equal(decisions.length, 2);
  await session.setModel(cheapest.id);
  const third = await session.sendAndWait({
    prompt: "Return only the result of 3 + 3. Do not use tools or read files.",
  }, 90000);
  assert.equal(third?.data.content.trim(), "6");
  assert.equal(decisions.length, 2);
  console.log(JSON.stringify({
    picker: picker.name, selectionId: picker.id,
    routedAnswers: [first.data.content, second.data.content],
    routedTurns: decisions.length, toolCalls,
    manualModel: cheapest.id, manualAnswer: third.data.content, decisions,
  }, null, 2));
} finally {
  try {
    if (session) await session.disconnect();
    const errors = await client.stop();
    if (errors.length) throw new AggregateError(errors, "Native router smoke cleanup failed.");
  } finally { await rm(cwd, { recursive: true }); }
}
