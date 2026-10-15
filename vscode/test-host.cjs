const assert = require("node:assert/strict");
const fs = require("node:fs");
const vscode = require("vscode");

exports.run = async function () {
  const extension = vscode.extensions.getExtension("local-jev.decision-router");
  assert.ok(extension, "Decision Router extension is present");
  const { provider } = await extension.activate();
  const models = await vscode.lm.selectChatModels({ vendor: "decision-router" });
  assert.equal(models.length, 1, "native model registry contains the router");
  assert.equal(models[0].name, "decision-router");
  assert.equal(models[0].vendor, "decision-router");
  const information = provider.provideLanguageModelChatInformation()[0];
  const cancellation = new vscode.CancellationTokenSource();
  assert.equal(await provider.provideTokenCount(information, "abc", cancellation.token), 3);
  cancellation.cancel();
  await assert.rejects(provider.provideTokenCount(information, "abc", cancellation.token), vscode.CancellationError);
  await assert.rejects(
    provider.provideLanguageModelChatResponse(information, [], {}, { report() {} }, cancellation.token),
    vscode.CancellationError,
  );
  cancellation.dispose();
  const result = { editor: vscode.version, active: extension.isActive, models: models.map(({ name, vendor, id }) => ({ name, vendor, id })) };
  console.log("JEV_EDITOR_REGISTRY " + JSON.stringify(result));
  if (process.env.JEV_EDITOR_PROBE_RESULT) fs.writeFileSync(process.env.JEV_EDITOR_PROBE_RESULT, JSON.stringify(result));
};
