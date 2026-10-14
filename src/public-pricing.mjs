export const pricingUrl = "https://docs.github.com/api/article/body?pathname=/en/copilot/reference/copilot-billing/models-and-pricing";

export const modelNameKey = (name) => String(name).normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");

export function parsePublicPricing(markdown) {
  if (!markdown.toLowerCase().includes("per 1 million tokens")) {
    throw new Error("GitHub pricing document does not declare per-million-token units.");
  }
  const prices = new Map();
  let headers = [];
  for (const line of markdown.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    if (cells[0] === "Model") { headers = cells; continue; }
    const inputColumn = headers.indexOf("Input");
    const outputColumn = headers.indexOf("Output");
    if (!cells[0] || inputColumn < 0 || outputColumn < 0 || cells.every((cell) => /^[:\s-]*$/.test(cell))) continue;
    const tierColumn = headers.indexOf("Tier");
    if (tierColumn >= 0 && cells[tierColumn] !== "Default") continue;
    const dollars = (value) => /^\$[\d,.]+$/.test(value ?? "") ? Number(value.replace(/[$,]/g, "")) : NaN;
    const inputUsdPerMillion = dollars(cells[inputColumn]);
    const outputUsdPerMillion = dollars(cells[outputColumn]);
    if (!Number.isFinite(inputUsdPerMillion) || !Number.isFinite(outputUsdPerMillion)) continue;
    const name = cells[0].replace(/\[\^[^\]]+\]/g, "").replace(/\*/g, "").trim();
    const thresholdColumn = headers.findIndex((header) => header.startsWith("Threshold"));
    const threshold = cells[thresholdColumn]?.match(/(?:≤|<=)\s*([\d.]+)\s*([kKmM])?/);
    const promptLimit = threshold ? Number(threshold[1]) * (
      threshold[2]?.toLowerCase() === "k" ? 1000 : threshold[2]?.toLowerCase() === "m" ? 1000000 : 1
    ) : null;
    const entry = { name, inputUsdPerMillion, outputUsdPerMillion, promptLimit, source: "github-public-pricing-default-tier" };
    const key = modelNameKey(name);
    if (prices.has(key)) throw new Error(`Ambiguous default pricing for ${name}.`);
    prices.set(key, entry);
  }
  if (!prices.size) throw new Error("No valid model prices found in the GitHub pricing document.");
  return prices;
}

export function matchPublicPrice(model, prices) {
  for (const value of [model.id, model.name, model.family]) {
    if (value && prices.has(modelNameKey(value))) return prices.get(modelNameKey(value));
  }
  return null;
}

let cache;
/** @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch, now?: number }} [options] */
export async function getPublicPricing({ signal, fetchImpl = fetch, now = Date.now() } = {}) {
  if (cache && now - cache.timestamp < 3600000) return cache.prices;
  const response = await fetchImpl(pricingUrl, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub pricing lookup failed (HTTP ${response.status}).`);
  const prices = parsePublicPricing(await response.text());
  cache = { timestamp: now, prices };
  return prices;
}
