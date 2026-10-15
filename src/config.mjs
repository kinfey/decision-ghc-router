import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
export { safeError } from "./errors.mjs";

export const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

export async function loadEnvironment(cwd, inherited = process.env) {
  const env = {};
  for (const file of new Set([resolve(appDirectory, ".env"), resolve(cwd, ".env")])) {
    try {
      Object.assign(env, parseEnv(await readFile(file, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { ...env, ...inherited };
}

export function positiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return Number(value);
}

export async function executablePath(command, env, cwd) {
  const candidates = isAbsolute(command) || command.includes("/")
    ? [resolve(cwd, command)]
    : (env.PATH ?? "").split(delimiter).map((directory) => resolve(cwd, directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error(`Copilot executable not found: ${command}. Install Copilot CLI or set COPILOT_CLI_PATH.`);
}

export function copilotEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.startsWith("JEV_") && !key.startsWith("TYPESAFE_") && !key.startsWith("AZURE_DECISION_")));
}
