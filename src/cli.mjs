import { spawn } from "node:child_process";
import { constants } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { copilotEnvironment, executablePath, loadEnvironment, positiveInteger, safeError } from "./config.mjs";
import { discoverModels, pricedModels } from "./catalog.mjs";
import { selectModel } from "./router.mjs";

export const help = `JEV -> native GitHub Copilot CLI (native /model extension or startup routing)

  npm run install:router                Install the user-level /model extension
  npm run router                        Open native CLI; select Jev Router in /model
  npm start -- "task"                    Route, then open native interactive CLI
  npm start -- -p "task" -- [CLI flags]   Route, then run native prompt mode
  npm start -- -i "task"                 Route, then open native interactive CLI
  npm start -- route "task"              Show decision without executing Copilot
  npm run models                        Show account models and live prices

Options:
  --model ID              Explicit account model; skip JEV
  --input-tokens N        Estimated uncached input tokens (default: 10000)
  --output-tokens N       Estimated output tokens (default: 2000)
  --context TIER          default | long_context (default: default)
  -C DIRECTORY            Target project and local .env
  --json                  JSON output for models/route
  --dry-run               Same as route
  -h, --help              Show help without network calls

Native flags go after --. Permissions remain under native Copilot control.
The router command enables the user extension; choose Jev Router in /model for per-turn routing.
Ordinary task mode routes at startup only. Concrete native models bypass JEV.
Automatic routing sends the current user task and model prices to TypeSafe/JEV.
Estimates exclude cache charges, tool loops, JEV fees and subscription allowances.
`;

export function parseArguments(argv) {
  const options = { command: "run", cwd: process.cwd(), context: "default", forward: [], words: [] };
  const args = [...argv];
  if (["models", "route", "router"].includes(args[0])) options.command = args.shift();
  const valueFlags = new Map([
    ["--model", "model"], ["--input-tokens", "inputTokens"], ["--output-tokens", "outputTokens"],
    ["--context", "context"], ["-C", "cwd"], ["-p", "prompt"], ["--prompt", "prompt"],
    ["-i", "interactive"], ["--interactive", "interactive"],
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      options.forward = args.slice(index + 1);
      break;
    }
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--dry-run") options.command = "route";
    else {
      const equal = arg.indexOf("=");
      const flag = equal >= 0 ? arg.slice(0, equal) : arg;
      const key = valueFlags.get(flag);
      if (key) {
        const value = equal >= 0 ? arg.slice(equal + 1) : args[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
        if (options[key] !== undefined && !["cwd", "context"].includes(key)) throw new Error(`Duplicate option ${flag}.`);
        options[key] = value;
      } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}. Native CLI flags must follow --.`);
      else options.words.push(arg);
    }
  }
  if (options.prompt !== undefined && options.interactive !== undefined) throw new Error("Choose either -p or -i.");
  if (options.words.length && (options.prompt !== undefined || options.interactive !== undefined)) {
    throw new Error("Supply the task either positionally or with -p/-i, not both.");
  }
  options.task = options.prompt ?? options.interactive ?? options.words.join(" ");
  options.cwd = resolve(options.cwd);
  if (!["default", "long_context"].includes(options.context)) throw new Error("Invalid --context tier.");
  if (options.json && options.command === "run") throw new Error("--json requires route, models or --dry-run.");
  if (!["run", "router"].includes(options.command) && options.forward.length) throw new Error("Native CLI flags require execution mode.");
  if (options.command === "models" && options.task) throw new Error("models does not accept a task.");
  for (const arg of options.forward) {
    if (/^(--model|--context|--prompt|--interactive|--connect|--acp|--fleet|--agent|-p|-i|-C)(=|$)/.test(arg) ||
        /^-[piC].+/.test(arg)) {
      throw new Error(`Native flag ${arg} can bypass the routing decision. Use wrapper options; agents/fleet/connect are not supported.`);
    }
  }
  return options;
}

export function nativeArguments(options, decision) {
  return [
    "--model", decision.id, "--context", options.context,
    ...(options.task ? [options.prompt !== undefined ? "-p" : "-i", options.task] : []),
    ...options.forward,
  ];
}

export function launchCopilot(executable, args, { cwd, env }) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(executable, args, { cwd, env: copilotEnvironment(env), stdio: "inherit", shell: false });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const clean = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", (error) => { clean(); reject(error); });
    child.once("close", (code, signal) => {
      clean();
      resolveExit(code ?? 128 + (constants.signals[signal] ?? 1));
    });
  });
}

export async function main(argv, dependencies = {}) {
  let env = process.env;
  try {
    const options = parseArguments(argv);
    if (options.help) { console.log(help); return 0; }
    env = await loadEnvironment(options.cwd);
    if (options.command === "router") {
      if (options.model || options.task || options.json || options.inputTokens || options.outputTokens ||
          options.context !== "default") {
        throw new Error("router opens the native model picker; supply only -C and native flags after --.");
      }
      const executable = await executablePath(env.COPILOT_CLI_PATH || "copilot", env, options.cwd);
      return await (dependencies.launchCopilot ?? launchCopilot)(executable, ["--experimental", ...options.forward], {
        cwd: options.cwd, env: { ...env, COPILOT_ALLOW_GET_PROVIDER_ENDPOINT: "true" },
      });
    }
    const estimates = {
      inputTokens: positiveInteger(options.inputTokens ?? env.JEV_INPUT_TOKENS ?? "10000", "input tokens"),
      outputTokens: positiveInteger(options.outputTokens ?? env.JEV_OUTPUT_TOKENS ?? "2000", "output tokens"),
      context: options.context,
    };
    if (options.command !== "models" && !options.task.trim() && !options.model) {
      if (options.command === "route" || !process.stdin.isTTY) throw new Error("A nonempty task is required for automatic routing.");
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try { options.task = await readline.question("Task (sent to JEV for model selection): "); }
      finally { readline.close(); }
      if (!options.task.trim()) throw new Error("A nonempty task is required for automatic routing.");
    }
    if (options.command !== "models" && !options.model &&
        !env.JEV_API_KEY && !env.TYPESAFE_API_KEY && env.JEV_FALLBACK_CHEAPEST !== "1") {
      throw new Error("JEV_API_KEY is missing. Add it to the local .env file.");
    }
    const executable = await executablePath(env.COPILOT_CLI_PATH || "copilot", env, options.cwd);
    const catalog = await (dependencies.discoverModels ?? discoverModels)({ executable, cwd: options.cwd, env });
    const candidates = pricedModels(catalog, estimates);
    if (options.command === "models") {
      const output = {
        estimates,
        models: candidates,
        excluded: catalog.filter((entry) => !candidates.some((model) => model.id === entry.id)).map((entry) => ({
          id: entry.id, policy: entry.policy?.state ?? null,
          reason: entry.id === "auto" ? "not-an-exact-model" :
            entry.policy && entry.policy.state !== "enabled" ? "not-enabled" : "missing-price-or-insufficient-context",
        })),
      };
      if (options.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.table(candidates.map((model) => ({
          model: model.id, "input $/1M": model.inputUsdPerMillion, "output $/1M": model.outputUsdPerMillion,
          "cache read $/1M": model.cacheReadUsdPerMillion, "cache write $/1M": model.cacheWriteUsdPerMillion,
          "estimated USD": model.estimatedUsd.toFixed(6),
        })));
        console.log(`Live catalog; estimated ${estimates.inputTokens} uncached input + ${estimates.outputTokens} output tokens, ${options.context}.`);
        if (output.excluded.length) console.log(`Excluded: ${output.excluded.map((entry) => `${entry.id} (${entry.reason})`).join(", ")}`);
      }
      return 0;
    }
    const decision = await selectModel({
      model: options.model, catalog, candidates, prompt: options.task, estimates, env,
      warn: (message) => console.error(`[JEV warning] ${message}`),
      client: dependencies.jevClient,
    });
    if (options.command === "route") {
      console.log(JSON.stringify({ decision, estimates, executed: false }, null, 2));
      return 0;
    }
    console.error(`[JEV] ${decision.id} (${decision.reason}${decision.confidence === null ? "" : `, confidence ${decision.confidence.toFixed(2)}`}), estimated $${decision.estimatedUsd.toFixed(6)}. Startup routing only; /model overrides manually.`);
    return await (dependencies.launchCopilot ?? launchCopilot)(executable, nativeArguments(options, decision), { cwd: options.cwd, env });
  } catch (error) {
    console.error(`[JEV error] ${safeError(error, env)}`);
    return 1;
  }
}
