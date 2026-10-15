import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const moduleUrl = pathToFileURL(resolve("src/extension.mjs")).href;

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), "decision-install-test-"));
  t.after(() => rm(home, { recursive: true }));
  const legacy = join(home, "extensions", "jev-router", "extension.mjs");
  const target = join(home, "extensions", "decision-router", "extension.mjs");
  await mkdir(join(home, "extensions", "jev-router"), { recursive: true });
  const install = (args = []) => run(process.execPath, ["bin/install-router.mjs", ...args], {
    cwd: process.cwd(), env: { ...process.env, COPILOT_HOME: home },
  });
  return { home, legacy, target, install };
}

test("renamed CLI installation migrates only this project's legacy entry and uninstalls cleanly", async (t) => {
  const { legacy, target, install } = await setup(t);
  await writeFile(legacy, `// Managed by jev-ghc-decision-app; no credentials are stored here.\nimport { startExtension } from ${JSON.stringify(moduleUrl)};\nawait startExtension();\n`);
  await install();
  const text = await readFile(target, "utf8");
  assert.ok(text.startsWith("// Managed by decision-router;"));
  assert.ok(text.includes(JSON.stringify(moduleUrl)));
  await assert.rejects(readFile(legacy), { code: "ENOENT" });
  await install();
  await install(["--uninstall"]);
  await assert.rejects(readFile(target), { code: "ENOENT" });
});

test("rename migration preserves unrelated extension entries", async (t) => {
  const { legacy, target, install } = await setup(t);
  const unrelated = "// An unrelated extension\n";
  await writeFile(legacy, unrelated);
  const result = await install();
  assert.match(result.stderr, /Preserved an unrelated legacy extension/);
  assert.equal(await readFile(legacy, "utf8"), unrelated);
  await writeFile(target, unrelated);
  await assert.rejects(install(), /Refusing to overwrite/);
  assert.equal(await readFile(target, "utf8"), unrelated);
});

test("corrected spelling migrates the misspelled managed CLI entry", async (t) => {
  const { home, target, install } = await setup(t);
  const directory = join(home, "extensions", "desicion-router");
  await mkdir(directory, { recursive: true });
  const legacy = join(directory, "extension.mjs");
  await writeFile(legacy, `// Managed by desicion-router; no credentials are stored here.\nimport { startExtension } from ${JSON.stringify(moduleUrl)};\nawait startExtension();\n`);
  await install();
  assert.ok((await readFile(target, "utf8")).startsWith("// Managed by decision-router;"));
  await assert.rejects(readFile(legacy), { code: "ENOENT" });
});
