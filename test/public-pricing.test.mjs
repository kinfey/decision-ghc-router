import assert from "node:assert/strict";
import { test } from "node:test";
import { matchPublicPrice, parsePublicPricing } from "../src/public-pricing.mjs";

const markdown = `All prices are **per 1 million tokens**.
| Model | Tier | Threshold (input tokens) | Input | Cached input | Cache write | Output |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| GPT-6 Luna | Default | ≤ 272K | $0.10 | $0.01 | $0.125 | $0.50 |
| GPT-6 Luna | Long context | > 272K | $0.20 | $0.02 | $0.25 | $0.75 |
| GPT-6.1 Sol | Default | ≤ 272K | $2.00 | $0.10 | $2.50 | $10.00 |
| | | | | | | |
| Model | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| Gemini 3.8 Flash[^promo] | $0.75 | $0.075 | $3.75 |
`;

test("public pricing parser distinguishes default and long context, currency and threshold", () => {
  const prices = parsePublicPricing(markdown);
  assert.equal(prices.size, 3);
  const cheap = matchPublicPrice({ id: "gpt-6-luna" }, prices);
  assert.equal(cheap.inputUsdPerMillion, 0.1);
  assert.equal(cheap.outputUsdPerMillion, 0.5);
  assert.equal(cheap.promptLimit, 272000);
  assert.equal(matchPublicPrice({ name: "Gemini 3.8 Flash" }, prices).inputUsdPerMillion, 0.75);
  assert.equal(matchPublicPrice({ id: "gpt-6.1-sol" }, prices).outputUsdPerMillion, 10);
});

test("price matches are exact across versions, not guessed from model families", () => {
  const prices = parsePublicPricing(markdown);
  assert.equal(matchPublicPrice({ id: "future-model", family: "gpt-6" }, prices), null);
  assert.equal(matchPublicPrice({ id: "gpt-6-sol" }, prices), null);
  assert.equal(matchPublicPrice({ id: "native/vendor-id", name: "GPT-6 Luna" }, prices).inputUsdPerMillion, 0.1);
});

test("missing units, malformed prices and ambiguous rows fail rather than appear free", () => {
  assert.throws(() => parsePublicPricing(markdown.replace("per 1 million tokens", "per request")), /units/);
  assert.throws(() => parsePublicPricing("per 1 million tokens\n| Model | Input | Output |\n| Unknown | free | ? |"), /No valid/);
  assert.throws(() => parsePublicPricing(`${markdown}\n| GPT-6 Luna | $0.20 | $0.01 | $0.50 |`), /Ambiguous/);
});
