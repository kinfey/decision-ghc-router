import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { askJev } from "../../src/router.mjs";
import { safeError } from "../../src/errors.mjs";
import { getPublicPricing, matchPublicPrice } from "../../src/public-pricing.mjs";

declare const __JEV_DEFAULT_ENV_FILE__: string;

interface Candidate {
  id: string;
  name: string;
  context: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  estimatedUsd: number;
  promptLimit: number;
  source: string;
}

interface Route {
  modelId: string;
  estimatedUsd: number;
}

function inputPart(part: unknown): vscode.LanguageModelInputPart {
  if (part instanceof vscode.LanguageModelTextPart ||
      part instanceof vscode.LanguageModelToolCallPart ||
      part instanceof vscode.LanguageModelToolResultPart) return part;
  if (part instanceof vscode.LanguageModelDataPart && !part.mimeType.startsWith("image/")) return part;
  throw new Error("Desicion Router received an unsupported message part. Image inputs are not supported.");
}

function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]) {
  return messages.map((message) => {
    if (message.role !== vscode.LanguageModelChatMessageRole.User &&
        message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
      throw new Error("This VS Code request contains a message role unsupported by the public Copilot API.");
    }
    return new vscode.LanguageModelChatMessage(message.role, message.content.map(inputPart), message.name);
  });
}

function positive(value: string | undefined, defaultValue: number, name: string) {
  if (value === undefined) return defaultValue;
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number)) throw new Error(`${name} must be a positive integer.`);
  return number;
}

function isSecret(text: string, env: NodeJS.ProcessEnv) {
  return /\bapikey_[A-Za-z0-9_]+\b/.test(text) || Object.entries(env).some(([key, value]) =>
    value && value.length >= 12 && /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && text.includes(value));
}

async function taskSummary(messages: readonly vscode.LanguageModelChatRequestMessage[], env: NodeJS.ProcessEnv, token: vscode.CancellationToken) {
  const latest = [...messages].reverse().find((message) =>
    message.role === vscode.LanguageModelChatMessageRole.User &&
    !message.content.some((part) => part instanceof vscode.LanguageModelToolResultPart) &&
    message.content.some((part) => part instanceof vscode.LanguageModelTextPart));
  if (!latest) throw new Error("No user task was found for routing.");
  const text = latest.content.filter((part): part is vscode.LanguageModelTextPart =>
    part instanceof vscode.LanguageModelTextPart).map((part) => part.value).join("\n");
  const tagged = [...text.matchAll(/<(?:userRequest|user_request)>([\s\S]*?)<\/(?:userRequest|user_request)>/g)];
  let summary: string | undefined;
  if (tagged.length === 1 && tagged[0][1].trim().length <= 4000) summary = tagged[0][1].trim();
  else {
    summary = await vscode.window.showInputBox({
      title: "Desicion Router: routing task summary",
      prompt: "Only this summary is sent to JEV. Do not include secrets or file contents. VS Code context is not uploaded to JEV.",
      placeHolder: "Describe the task, for example: implement a discount function and add boundary tests",
      ignoreFocusOut: true,
      validateInput: (value) => !value.trim() ? "A task summary is required." :
        value.length > 4000 ? "Use at most 4,000 characters." :
        isSecret(value, env) ? "Remove credentials from the summary." : undefined,
    }, token);
  }
  if (summary === undefined) throw new vscode.CancellationError();
  if (!summary.trim()) throw new Error("A nonempty routing summary is required.");
  if (isSecret(summary, env)) throw new Error("The routing summary contains a credential. Remove it before routing.");
  return summary;
}

export class JevProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;
  private readonly toolRoutes = new Map<string, Route>();

  constructor(private readonly output: vscode.OutputChannel) {}

  refresh() { this.changed.fire(); }
  dispose() { this.changed.dispose(); this.toolRoutes.clear(); }

  provideLanguageModelChatInformation(): vscode.LanguageModelChatInformation[] {
    return [{
      id: "desicion-router", name: "desicion-router", family: "desicion-router", version: "0.1.0",
      maxInputTokens: 128000, maxOutputTokens: 16000,
      tooltip: "JEV selects a low-cost sufficient model from this editor's available GitHub Copilot models.",
      detail: "JEV -> GitHub Copilot; actual Copilot usage still applies",
      capabilities: { toolCalling: true, imageInput: false },
    }];
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    return Buffer.byteLength(typeof text === "string" ? text : JSON.stringify(text), "utf8");
  }

  private continuation(messages: readonly vscode.LanguageModelChatRequestMessage[]): Route | undefined {
    const results = messages.at(-1)?.content.filter((part): part is vscode.LanguageModelToolResultPart =>
      part instanceof vscode.LanguageModelToolResultPart) ?? [];
    if (!results.length) return undefined;
    const routes = results.map((result) => this.toolRoutes.get(result.callId));
    if (routes.some((route) => !route)) throw new Error("The previous tool-call route is unavailable. Start a new user turn.");
    const first = routes[0];
    if (!first || routes.some((route) => route?.modelId !== first.modelId)) {
      throw new Error("Tool results from different routed models cannot be mixed.");
    }
    return first;
  }

  private async environment(): Promise<NodeJS.ProcessEnv> {
    const file = vscode.workspace.getConfiguration("desicionRouter").get<string>("envFile") ||
      vscode.workspace.getConfiguration("jevRouter").get<string>("envFile") || __JEV_DEFAULT_ENV_FILE__;
    if (!isAbsolute(file)) throw new Error("Desicion Router envFile must be an absolute path.");
    let values;
    try { values = parseEnv(await readFile(file, "utf8")); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read Desicion Router .env. Run "Desicion Router: Configure .env". ${reason}`);
    }
    return { ...values, ...process.env };
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    let env: NodeJS.ProcessEnv = {};
    const abort = new AbortController();
    const cancel = token.onCancellationRequested(() => abort.abort());
    try {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      if (model.id !== "desicion-router") throw new Error("Unknown Desicion Router model.");
      env = await this.environment();
      const advanced: Readonly<Record<string, unknown>> | undefined = options.modelOptions;
      if ([advanced?.contextTier, advanced?.context].includes("long_context")) {
        throw new Error("Desicion Router supports default-context pricing only.");
      }
      const converted = convertMessages(messages);
      const available = (await vscode.lm.selectChatModels({ vendor: "copilot" })).filter((entry) =>
        entry.vendor === "copilot" && entry.id !== "auto" && entry.family !== "auto");
      if (!available.length) throw new Error("No Copilot models are available to this editor account. Sign in to GitHub Copilot.");
      let route = this.continuation(messages);
      if (!route) {
        const summary = await taskSummary(messages, env, token);
        const prices = await getPublicPricing({ signal: abort.signal, fetchImpl: fetch, now: Date.now() });
        const outputTokens = positive(env.JEV_OUTPUT_TOKENS, 2000, "JEV_OUTPUT_TOKENS");
        if (outputTokens > 16000) throw new Error("JEV_OUTPUT_TOKENS must not exceed the router's 16,000-token output limit.");
        const minimumInput = positive(env.JEV_INPUT_TOKENS, 1, "JEV_INPUT_TOKENS");
        const candidates: Candidate[] = [];
        for (const target of available) {
          const price = matchPublicPrice(target, prices);
          if (!price) continue;
          const counts = await Promise.all(converted.map((message) => target.countTokens(message, token)));
          if (options.tools?.length) counts.push(await target.countTokens(JSON.stringify(options.tools), token));
          if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
            throw new Error(`Copilot returned an invalid token count for ${target.id}.`);
          }
          const inputTokens = Math.max(minimumInput, counts.reduce((total, count) => total + count, 0));
          const promptLimit = Math.min(target.maxInputTokens, price.promptLimit ?? target.maxInputTokens);
          if (inputTokens > promptLimit) continue;
          candidates.push({
            id: target.id, name: target.name, context: "default", promptLimit,
            inputUsdPerMillion: price.inputUsdPerMillion,
            outputUsdPerMillion: price.outputUsdPerMillion,
            estimatedUsd: (inputTokens * price.inputUsdPerMillion + outputTokens * price.outputUsdPerMillion) / 1000000,
            source: price.source,
          });
        }
        candidates.sort((left, right) => left.estimatedUsd - right.estimatedUsd || left.id.localeCompare(right.id));
        if (!candidates.length) throw new Error("No available Copilot model has a matching public price and sufficient default context.");
        const decision = await askJev({
          prompt: summary, models: candidates, estimates: { outputTokens, context: "default" },
          apiKey: env.JEV_API_KEY || env.TYPESAFE_API_KEY, client: undefined, signal: abort.signal, env,
        });
        route = { modelId: decision.id, estimatedUsd: decision.estimatedUsd };
        this.output.appendLine(`JEV (${decision.reason}) -> ${decision.id}; confidence ${decision.confidence.toFixed(2)}; estimated $${decision.estimatedUsd.toFixed(6)}. Public default prices exclude promotions and classifier fees.`);
      }
      const target = available.find((entry) => entry.id === route.modelId);
      if (!target) throw new Error("The routed model is no longer available to this editor account. Start a new user turn.");
      const response = await target.sendRequest(converted, {
        tools: options.tools ? [...options.tools] : undefined,
        toolMode: options.toolMode,
        modelOptions: options.modelOptions,
        justification: "Desicion Router needs access to the selected GitHub Copilot model to execute your chat task.",
      }, token);
      for await (const part of response.stream) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        if (!(part instanceof vscode.LanguageModelTextPart || part instanceof vscode.LanguageModelToolCallPart ||
              part instanceof vscode.LanguageModelToolResultPart || part instanceof vscode.LanguageModelDataPart)) {
          throw new Error("Copilot returned an unsupported response part.");
        }
        if (part instanceof vscode.LanguageModelToolCallPart) {
          this.toolRoutes.set(part.callId, route);
          if (this.toolRoutes.size > 512) {
            const oldest = this.toolRoutes.keys().next().value;
            if (oldest !== undefined) this.toolRoutes.delete(oldest);
          }
        }
        progress.report(part);
      }
    } catch (error) {
      if (token.isCancellationRequested || error instanceof vscode.CancellationError) throw new vscode.CancellationError();
      const message = safeError(error, env);
      this.output.appendLine(`ERROR: ${message}`);
      throw new Error(message);
    } finally { cancel.dispose(); }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Desicion Router");
  const provider = new JevProvider(output);
  context.subscriptions.push(output, provider,
    vscode.lm.registerLanguageModelChatProvider("desicion-router", provider),
    vscode.commands.registerCommand("desicionRouter.configure", async () => {
      const selected = await vscode.window.showOpenDialog({
        title: "Choose the .env containing TypeSafe or Azure Decision credentials",
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      });
      if (selected?.[0]) {
        await vscode.workspace.getConfiguration("desicionRouter").update("envFile", selected[0].fsPath, vscode.ConfigurationTarget.Global);
        provider.refresh();
        vscode.window.showInformationMessage("Desicion Router .env configured. Select desicion-router in the chat model picker.");
      }
    }),
    vscode.commands.registerCommand("desicionRouter.refresh", () => provider.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("desicionRouter.envFile") || event.affectsConfiguration("jevRouter.envFile")) provider.refresh();
    }),
  );
  return { provider };
}
