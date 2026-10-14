#!/usr/bin/env node
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appDirectory } from "../src/config.mjs";

const directory = resolve(process.env.COPILOT_HOME || resolve(homedir(), ".copilot"), "extensions", "jev-router");
const target = resolve(directory, "extension.mjs");
const moduleUrl = pathToFileURL(resolve(appDirectory, "src", "extension.mjs")).href;
const content = `// Managed by jev-ghc-decision-app; no credentials are stored here.\nimport { startExtension } from ${JSON.stringify(moduleUrl)};\nawait startExtension();\n`;
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--uninstall")) {
    throw new Error("Usage: node bin/install-router.mjs [--uninstall]");
  }
  let existing;
  try { existing = await readFile(target, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing && !existing.startsWith("// Managed by jev-ghc-decision-app;")) {
    throw new Error(`Refusing to overwrite an unrelated extension: ${target}`);
  }
  if (args[0] === "--uninstall") {
    if (existing) await unlink(target);
    console.log(`Removed managed extension entry: ${target}. Restart Copilot to unload it.`);
  } else {
    await mkdir(directory, { recursive: true });
    await writeFile(target, content, { mode: 0o600 });
    console.log(`Installed user extension: ${target}`);
    console.log("Start: COPILOT_ALLOW_GET_PROVIDER_ENDPOINT=true copilot --experimental");
    console.log("Then select Jev Router in /model. No login or global default model was changed.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
