import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { normalizeCatalogModel, pricedModels } from "./catalog.mjs";
import { positiveInteger, safeError } from "./config.mjs";
import { selectModel } from "./router.mjs";

export const routerId = "jev/router";
const maximumBodyBytes = 32 * 1024 * 1024;

export function registration(baseUrl, apiKey) {
  return {
    providers: [{ name: "jev", type: "openai", wireApi: "responses", baseUrl, apiKey }],
    models: [{
      provider: "jev", id: "router", name: "Jev Router", wireModel: "jev-router",
      maxPromptTokens: 128000, maxOutputTokens: 16000, maxContextWindowTokens: 144000,
      capabilities: { supports: { vision: false, toolCalls: true, reasoningEffort: false } },
    }],
  };
}

export function rewriteRequest(body, decision, model) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a Responses API request object.");
  if (body.model !== "jev-router" && body.model !== routerId) throw new Error("Unknown router wire model.");
  if (body.previous_response_id) throw new Error("Stateful previous_response_id is not supported; send the full conversation.");
  const rewritten = { ...body, model: decision.id };
  if (body.reasoning && !model.capabilities?.supports?.reasoningEffort) delete rewritten.reasoning;
  const maximum = model.capabilities?.limits?.max_output_tokens;
  if (maximum > 0 && rewritten.max_output_tokens > maximum) {
    throw new Error(`Requested output exceeds the selected model's limit (${maximum}).`);
  }
  return rewritten;
}

export function createTurnRouter({ session, env, log, jevClient }) {
  let turn = null;
  let sequence = 0;

  return {
    async submitted(prompt) {
      const current = await session.rpc.model.getCurrent();
      if (current.modelId !== routerId) return;
      const active = { sequence: ++sequence, decision: null, model: null, error: null };
      turn = active;
      try {
        const context = current.contextTier ?? "default";
        if (context !== "default") throw new Error("Jev Router currently supports the default context tier only.");
        const estimates = {
          inputTokens: positiveInteger(env.JEV_INPUT_TOKENS ?? "10000", "input tokens"),
          outputTokens: positiveInteger(env.JEV_OUTPUT_TOKENS ?? "2000", "output tokens"),
          context,
        };
        const response = await session.rpc.model.list({ skipCache: true });
        const catalog = response.list.filter((model) => model.provider?.kind === "copilot" &&
          (!model.supported_endpoints || model.supported_endpoints.includes("/responses")))
          .map(normalizeCatalogModel);
        const candidates = pricedModels(catalog, estimates);
        active.decision = await selectModel({
          catalog, candidates, prompt, estimates, env, client: jevClient,
          warn: (message) => log(message, "warning"),
        });
        active.model = catalog.find((model) => model.id === active.decision.id);
        await log(`JEV -> ${active.decision.id} (${active.decision.reason}, confidence ${
          active.decision.confidence === null ? "n/a" : active.decision.confidence.toFixed(2)
        }); estimated $${active.decision.estimatedUsd.toFixed(6)}. Tool continuations stay on this model.`, "info");
      } catch (error) {
        active.error = new Error(safeError(error, env));
        await log(`Jev Router blocked this turn: ${active.error.message}`, "error");
      }
    },
    current() {
      if (!turn) throw new Error("No routed user turn is ready. Submit a new task after selecting Jev Router.");
      if (turn.error) throw turn.error;
      if (!turn.decision || !turn.model) throw new Error("JEV routing has not finished.");
      return turn;
    },
  };
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBodyBytes) throw new Error("Router request exceeds the 32 MiB limit.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid JSON in the router request.");
  }
}

export async function startProxy({ session, turns, env, log, fetchImpl = fetch }) {
  const apiKey = randomBytes(32).toString("hex");
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Unauthorized local router request." } }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Only POST /v1/responses is supported." } }));
      return;
    }
    const abort = new AbortController();
    request.once("aborted", () => abort.abort());
    response.once("close", () => { if (!response.writableEnded) abort.abort(); });
    try {
      const body = await readBody(request);
      const turn = turns.current();
      const rewritten = rewriteRequest(body, turn.decision, turn.model);
      const endpoint = await session.rpc.provider.getEndpoint({ modelId: turn.decision.id });
      if (endpoint.type !== "openai" || endpoint.wireApi !== "responses" ||
          (endpoint.transport && endpoint.transport !== "http")) {
        throw new Error(`Selected model ${turn.decision.id} does not expose an OpenAI Responses HTTP endpoint.`);
      }
      const url = new URL(`${endpoint.baseUrl.replace(/\/+$/, "")}/responses`);
      if (url.protocol !== "https:") throw new Error("The GitHub inference endpoint must use HTTPS.");
      const headers = new Headers(endpoint.headers);
      if (!headers.has("authorization") && endpoint.apiKey) headers.set("authorization", `Bearer ${endpoint.apiKey}`);
      if (endpoint.sessionToken) {
        if (endpoint.sessionToken.model && endpoint.sessionToken.model !== turn.decision.id) {
          throw new Error("Runtime supplied a session token for a different model.");
        }
        headers.set(endpoint.sessionToken.header, endpoint.sessionToken.token);
      }
      headers.set("content-type", "application/json");
      const upstream = await fetchImpl(url, {
        method: "POST", headers, body: JSON.stringify(rewritten),
        redirect: "error", signal: abort.signal,
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw new Error(`GitHub inference for ${turn.decision.id} failed (HTTP ${upstream.status}).`);
      }
      if (!upstream.body) throw new Error("GitHub inference returned an empty response body.");
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-store",
      });
      await pipeline(Readable.fromWeb(upstream.body), response);
    } catch (error) {
      if (abort.signal.aborted) return;
      const message = safeError(error, env);
      await log(`Jev Router inference failed: ${message}`, "error");
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message, type: "jev_router_error" } }));
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local router did not bind a TCP port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
