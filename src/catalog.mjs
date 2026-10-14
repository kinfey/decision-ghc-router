import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { copilotEnvironment } from "./config.mjs";

export async function discoverModels({ executable, cwd, env }) {
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: executable, env: copilotEnvironment(env) }),
    workingDirectory: cwd,
    logLevel: "error",
  });
  try {
    await client.start();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) throw new Error("Copilot is not authenticated. Run copilot login first.");
    const models = await client.listModels();
    if (!Array.isArray(models) || models.length === 0) throw new Error("Copilot returned an empty model catalog.");
    return models;
  } finally {
    const errors = await client.stop();
    if (errors.length) {
      await client.forceStop();
      throw new Error("Copilot model discovery could not shut down cleanly.");
    }
  }
}

const nonnegative = (value) => Number.isFinite(value) && value >= 0;

export function normalizeCatalogModel(model) {
  const raw = model.billing?.token_prices;
  const normalizePrices = (prices) => prices ? {
    inputPrice: prices.input_price,
    outputPrice: prices.output_price,
    cacheReadPrice: prices.cache_read_price,
    cacheWritePrice: prices.cache_write_price,
    maxPromptTokens: prices.max_prompt_tokens,
  } : undefined;
  const supports = model.capabilities?.supports;
  return {
    ...model,
    billing: {
      ...model.billing,
      tokenPrices: model.billing?.tokenPrices ?? (raw ? {
        ...normalizePrices(raw.default),
        batchSize: raw.batch_size,
        longContext: normalizePrices(raw.long_context),
      } : undefined),
    },
    capabilities: {
      ...model.capabilities,
      supports: {
        ...supports,
        reasoningEffort: supports?.reasoningEffort ?? (Array.isArray(supports?.reasoning_effort) && supports.reasoning_effort.length > 0),
      },
    },
  };
}

export function pricedModels(models, { inputTokens, outputTokens, context }) {
  return models
    .map(normalizeCatalogModel)
    .filter((model) => model.id !== "auto" && model.model_picker_enabled !== false &&
      (!model.policy || model.policy.state === "enabled"))
    .map((model) => {
      const base = model.billing?.tokenPrices;
      const prices = context === "long_context" ? base?.longContext : base;
      const batch = base?.batchSize;
      if (!prices || !nonnegative(prices.inputPrice) || !nonnegative(prices.outputPrice) ||
          !Number.isFinite(batch) || batch <= 0) return null;
      const limits = model.capabilities?.limits;
      const promptLimits = [prices.maxPromptTokens ?? prices.contextMax, limits?.max_prompt_tokens]
        .filter((limit) => Number.isFinite(limit) && limit > 0);
      const promptLimit = promptLimits.length ? Math.min(...promptLimits) : null;
      if ((promptLimit > 0 && inputTokens > promptLimit) ||
          (limits?.max_output_tokens > 0 && outputTokens > limits.max_output_tokens) ||
          (limits?.max_context_window_tokens > 0 &&
            inputTokens + outputTokens > limits.max_context_window_tokens)) return null;
      const usdPerMillion = (price) => nonnegative(price) ? price * 10000 / batch : null;
      return {
        id: model.id,
        name: model.name,
        context,
        inputUsdPerMillion: usdPerMillion(prices.inputPrice),
        outputUsdPerMillion: usdPerMillion(prices.outputPrice),
        cacheReadUsdPerMillion: usdPerMillion(prices.cacheReadPrice ?? prices.cachePrice),
        cacheWriteUsdPerMillion: usdPerMillion(prices.cacheWritePrice),
        estimatedUsd: (inputTokens * prices.inputPrice + outputTokens * prices.outputPrice) / batch / 100,
        promptLimit: promptLimit ?? null,
        source: "copilot-live-catalog",
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.estimatedUsd - b.estimatedUsd || a.id.localeCompare(b.id));
}
