import { joinSession } from "@github/copilot-sdk/extension";
import { loadEnvironment, safeError } from "./config.mjs";
import { createTurnRouter, registration, routerId, startProxy } from "./native-router.mjs";

export async function startExtension() {
  let turns;
  let proxy;
  const session = await joinSession({
    requestedEnvironmentVariables: [
      "JEV_PROVIDER", "JEV_API_KEY", "TYPESAFE_API_KEY",
      "AZURE_DECISION_ENDPOINT", "AZURE_DECISION_API_KEY", "AZURE_DECISION_MODEL",
    ],
    hooks: {
      onUserPromptSubmitted: async (input) => {
        if (!turns) throw new Error("Decision Router is still initializing.");
        await turns.submitted(input.prompt);
      },
    },
  });
  const env = await loadEnvironment(process.cwd());
  const log = (message, level) => session.log(message, { level, ephemeral: true });
  try {
    turns = createTurnRouter({ session, env, log });
    proxy = await startProxy({ session, turns, env, log });
    await session.rpc.provider.add(registration(proxy.baseUrl, proxy.apiKey));
    await log("Decision Router is available in /model. It uses your Copilot account, not a free model: native BYOK cost displays/budgets may not track these GitHub charges. The decision backend receives each new user task, not the full conversation.", "warning");
  } catch (error) {
    if (proxy) await proxy.close();
    await log(`Decision Router initialization failed: ${safeError(error, env)}`, "error");
    throw error;
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await proxy.close();
      await session.rpc.provider.withdraw({ models: [routerId] });
      await session.disconnect();
    } catch (error) {
      console.error(`[JEV shutdown] ${safeError(error, env)}`);
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return { session, turns, proxy };
}
