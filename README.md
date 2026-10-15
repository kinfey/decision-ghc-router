# Desicion Router for GitHub Copilot

[English](README.md) | [简体中文](README.zh.md)

**JEV decides; GitHub Copilot executes.** Select **Desicion Router** in the native Copilot CLI `/model` menu or **desicion-router** in the VS Code / Insiders chat model picker. Alternatively, route the initial task before launching the CLI.

Classification supports both the **TypeSafe API** and **Azure Decision-1**. The selected backend only chooses a model; task execution still uses your available GitHub Copilot models.

The router chooses from models available to the signed-in account. It does not change login credentials or the global default model, and it does not make an additional Copilot request to classify the task.

```text
Native /model -> Desicion Router -> JEV classifies each new user turn
                           -> Local loopback proxy -> Available GitHub inference model
Native /model -> Specific model -> Native Copilot execution, without JEV
```

## Prerequisites and setup

Use Node.js 22.16 or later, install GitHub Copilot CLI, and sign in with `copilot login` using an account with access to the required models. Editor integration requires VS Code / Insiders 1.140 or later and a GitHub Copilot sign-in in that editor.

Run these commands from the project root:

```bash
npm install

# Copy only if .env does not already exist, then enter your own JEV key.
cp -n .env.example .env
chmod 600 .env
```

Do not overwrite an existing `.env`, commit it, or share its credentials. The project `.npmrc` uses the Microsoft npm source at `https://packagefeedproxy.microsoft.io/npm/`.

## Select Desicion Router in the native CLI

Install the user-level extension; installation is repeatable:

```bash
npm run install:router

# Launch with the required experimental interfaces, without granting tool permissions.
npm run router
```

Restart the CLI after installation. Approve the working-directory trust prompt and the **register hooks** permission requested by `user:desicion-router`; otherwise, the model entry may not load.

Enter `/model` and select **Desicion Router**, or select it directly with `/model desicion/router`. Its display name is `Desicion Router` and its selection ID is `desicion/router`. Each new routed user turn reports the execution model, for example:

```text
JEV -> gpt-6-luna (jev, confidence 0.98); estimated $0.002000.
```

The extension entry is installed at `~/.copilot/extensions/desicion-router/extension.mjs`, or under `COPILOT_HOME` when configured. To use it in another project:

```bash
cd /path/to/project
COPILOT_ALLOW_GET_PROVIDER_ENDPOINT=true copilot --experimental
# Select Desicion Router in /model.
```

`--experimental` enables the native extension interfaces. `COPILOT_ALLOW_GET_PROVIDER_ENDPOINT=true` explicitly allows the local proxy to obtain the current account's runtime inference endpoint and authentication through the SDK. No shell startup configuration is modified. Do not assume an ordinary `copilot` session has enabled these interfaces; an unavailable endpoint interface causes an explicit error, not a switch to another authentication method.

The account's specific models remain selectable. Choosing one bypasses JEV; choosing `Desicion Router` resumes routing. Tool continuations and subagent requests that inherit the router use the model selected for that turn, without repeating classification. Subagents that explicitly select a native model remain under native CLI control.

This integration supports default-context text and native tool calls for account models that expose `/responses`. It does not claim compatibility with images, Anthropic Messages API backends, or long context.

The proxy listens on a random `127.0.0.1` port and authenticates requests with random local credentials. SDK-provided GitHub credentials stay in memory and are used only for HTTPS requests to GitHub; they are not saved, logged, sent to JEV, or replaced with the local proxy credentials. Native tools, tool results, streaming, permissions, and conversation state are preserved without starting a separate hidden agent loop.

**Billing warning:** this is a custom provider entry, not a free official GitHub model. The CLI may display it as BYOK or with a zero multiplier. `/usage` and `--max-ai-credits` may not fully track GitHub AI credits consumed through the proxy. Actual execution-model charges still apply; use GitHub billing as the source of truth, not the displayed multiplier or a soft budget. The extension also displays a startup warning.

The installed entry references this project's source and dependencies, so keep the project directory available. Reinstall with `npm run install:router` after moving it. Installation also removes this project's previous managed entry when upgrading to the new name, while preserving unrelated extensions. To remove the managed entry, run `npm run uninstall:router` and restart Copilot. The installer does not change the global default model.

## VS Code and VS Code Insiders

This is a separate extension for the **native editor chat model picker**, not the CLI picker inside an integrated terminal. It requires VS Code 1.140 or later.

```bash
npm run check:vscode
npm run package:vscode

# macOS: install into each editor separately.
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension "$PWD/desicion-router.vsix" --force
"/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
  --install-extension "$PWD/desicion-router.vsix" --force
```

Run **Developer: Reload Window** in each editor, then select **desicion-router** in the chat model picker. If it is hidden, enable **Desicion Router / desicion-router** through **Manage Models**.

Run **Desicion Router: Configure .env** to choose the local file containing your TypeSafe or Azure credentials. Settings store only its path, not the key. The extension retains compatibility with the previous `.env` path setting. A locally built package defaults to the build project's `.env` path; the VSIX never includes that file. Reconfigure the path after moving the project. When upgrading, uninstall the previous editor extension after installing the renamed extension to avoid duplicate model entries.

Approve Copilot language-model access when the editor requests it. Candidates come from that editor's signed-in account through `vscode.lm.selectChatModels({ vendor: "copilot" })`; the CLI and editor are not assumed to use the same account.

Available models are matched by exact normalized identifiers, names, or families against the current official public default-tier price table. Unknown-price models and models whose measured input exceeds default-context limits are excluded. Estimated output defaults to 2,000 tokens and can be changed with `JEV_OUTPUT_TOKENS`. The public API does not expose each model's output limit, so this estimate is not an output-length guarantee; the execution model enforces its own request limits.

JEV receives the task from an unambiguous `<userRequest>` wrapper. If it cannot be reliably isolated from editor context, the extension asks for a **routing-only summary** rather than automatically uploading attachments, source files, or conversation history. Copilot receives the full conversation and tool definitions, and the editor invokes native tools. Tool-call IDs pin continuations to the selected model without another JEV decision.

Cancellation, missing keys, unmatched prices, low confidence, and API failures stop execution explicitly. The extension does not silently substitute another model.

Open **Output -> Desicion Router** to inspect the selected model and single-round estimate. Estimates use public default-tier prices and exclude promotions, cached-token discounts, later tool rounds, and JEV fees. They do not guarantee the final bill or free usage. Images and long-context tiers are unsupported, and administrator restrictions on custom providers are respected.

## Route once before launching the CLI

This mode asks JEV to route the initial task, then launches the native CLI with the selected concrete model. Later turns are not automatically rerouted.

```bash
# List account models by estimated cost, without JEV or model inference.
npm run models

# Classify only; do not execute the task.
npm start -- route "Add boundary tests to an existing function" --json

# Route, launch the interactive CLI, and submit the initial task.
npm start -- "Explain this project's entry point"

# Noninteractive execution; permissions remain under native CLI control.
npm start -- -p "Explain this project's entry point" -- --allow-all-tools

# Explicit model selection skips JEV; use an ID from your account catalog.
npm start -- --model gpt-6-luna -p "Calculate 2+2" -- --allow-all-tools

# Run against another project while preserving its working directory and tools.
npm start -- -C /path/to/project "Fix the failing tests"
```

You can also run `node bin/jev-copilot.mjs`; without arguments, it asks for the initial task. For a global command, run `npm link` in this directory, then use `desicion-router "task"`. The previous global command remains a compatibility alias. Existing `JEV_*`, TypeSafe, and Azure environment configuration is unchanged.

Place native CLI arguments after `--`, for example `--deny-tool=shell`, `--resume=<session-id>`, or `--max-ai-credits=30` (the current CLI minimum is 30). The launcher **does not grant tool permissions automatically**.

Use the launcher's own `--model`, `--context`, `-p`, `-i`, and `-C` options, not the passthrough section. Routing-bypass options such as `--agent`, `--fleet`, `--connect`, and `--acp` are unsupported.

## Cost-aware selection

Startup routing discovers the account catalog through Copilot SDK `getAuthStatus()` and `listModels()`. Native picker routing uses `session.rpc.model.list()` for the joined session, preserving its account, integrations, and permissions and supporting both snake_case and camelCase pricing metadata.

JEV receives only eligible concrete models with valid prices and sufficient estimated input/output capacity. CLI routing excludes `auto`, hidden, disabled, unconfigured, unpriced, and insufficient-context models. Native picker routing additionally excludes models without `/responses`; selecting those models directly in the native CLI is unaffected. Account access is discovered, not hardcoded.

The objective is **the cheapest model likely to complete the task reliably in one pass**, not the weakest model for every task. Difficult tasks may require a more expensive model. This is not a guarantee of the mathematically lowest actual total cost.

CLI pricing follows the [GitHub model billing documentation](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing), using runtime account `billing.tokenPrices` rather than legacy premium-request multipliers. Editor routing uses the current official public default-tier table.

```text
1 AI credit = $0.01
Estimated USD = (inputTokens * inputPrice + outputTokens * outputPrice)
                / batchSize / 100
```

SDK `inputPrice` and `outputPrice` are **AI credits per billing batch**, not dollars. CLI pricing output also shows cache-read/write rates. The basic estimate assumes uncached input and excludes cache operations, additional tool rounds, hidden context, retries, and JEV fees. It is not necessarily the amount charged beyond a subscription allowance. JEV fees depend on your TypeSafe plan.

For example, an available model priced at **$0.10 per million input tokens** and **$0.50 per million output tokens** has an estimated cost of **$0.002** for 10,000 input and 2,000 output tokens. This is an illustration, not a fixed price or account default; available models and prices are rediscovered at runtime.

Startup routing passes `--context default` unless you explicitly request `--context long_context`. Long-context selection uses that model's long-context prices and excludes models without the tier. Inputs above a default-tier threshold are not silently billed in the estimate at the cheaper rate. The native `Desicion Router` picker entry supports default context only and advertises conservative limits of 128,000 input and 16,000 output tokens.

```bash
npm start -- route "Your large-context task" \
  --input-tokens 300000 --output-tokens 4000 --context long_context
```

CLI token counts are **user estimates**, not tokenizer measurements or enforced limits. CLI classification does not inspect repository files, attachments, or existing conversation context, so provide reasonable estimates when resuming a session. Native `--max-ai-credits` is not a strict billing cap, especially for the custom router provider.

## Environment configuration

```dotenv
JEV_PROVIDER=typesafe
JEV_API_KEY=your_jev_api_key
COPILOT_CLI_PATH=copilot
JEV_INPUT_TOKENS=10000
JEV_OUTPUT_TOKENS=2000
JEV_FALLBACK_CHEAPEST=0
```

To classify through Azure instead, set the following in your local `.env`:

```dotenv
JEV_PROVIDER=azure
AZURE_DECISION_ENDPOINT=https://<your-resource>.services.ai.azure.com/providers/microsoft/v1/systemone
AZURE_DECISION_API_KEY=your_azure_api_key
AZURE_DECISION_MODEL=Decision-1
```

Use your own endpoint and deployment name. `Decision-1` is the default deployment name. Azure requests post the same typed `state`/`questions` choice payload plus `model` to the exact configured endpoint, using the `api-key` header. HTTPS is required and redirects are rejected. Azure credentials are separate from TypeSafe credentials; changing providers does not silently fall back to the other backend. With no `JEV_PROVIDER`, existing TypeSafe configuration remains the default.

This setting applies to startup routing, the native CLI extension, and both editor extensions. Restart CLI sessions or reload editor windows after updating installed extensions. Azure classifier usage is billed separately from Copilot execution, just as TypeSafe classifier usage is.

CLI precedence is process environment, then the target project's `.env` (selectable with `-C` in startup mode), then the launcher's `.env`. `TYPESAFE_API_KEY` is also accepted.

The editor reads `desicionRouter.envFile`, defaulting to the build project's `.env` path. Process environment values override that file. Editor routing measures input tokens and uses `JEV_INPUT_TOKENS` as an estimate floor; estimated output must not exceed 16,000 tokens.

JEV requests have a four-second client timeout and a five-second cancellation deadline, with no automatic retries. Timeouts, invalid choices, and confidence below 0.3 fail closed. CLI modes can explicitly enable `JEV_FALLBACK_CHEAPEST=1`, which warns and selects the lowest-priced candidate **without guaranteeing task suitability**. Editor routing does not use this fallback and stops on routing failures.

`.env` is ignored by Git; do not commit, share, or expose it in frontend code. The CLI launcher strips JEV/TypeSafe and `AZURE_DECISION_*` environment variables from the native child process, and errors are redacted. The native extension reads local configuration; environment overrides explicitly request SDK access to classifier configuration and credentials, which may require approval.

Native Copilot file tools can still read a working-directory `.env`; this is not a filesystem isolation mechanism. Do not ask tools to read or upload secret files. Rotate keys previously exposed in chat or public locations.

## Privacy and limitations

The native CLI picker routes each new user turn. Startup routing makes one decision at launch. Switching to a specific model invalidates the relevance of the previous model's estimate.

CLI automatic routing sends the current task text, candidate model names/prices, and token estimates to the selected decision backend: `https://api.typesafe.ai` for TypeSafe, or your configured Azure endpoint. It does not automatically read and upload repository files or full history, and it does not send GitHub credentials. Sensitive content placed directly in the task will nevertheless be sent.

Native CLI picker requests go through the local proxy to the SDK-provided GitHub inference endpoint. Editor execution uses the public Copilot language-model API, sending JEV only the isolated task or explicitly entered summary.

The `route` command calls JEV and may incur JEV fees. `models` and explicit concrete-model selection do not call JEV.

## Development

```bash
npm test
```

Offline tests cover catalog normalization, billing units, cost ordering, eligibility and context limits, invalid/low-confidence decisions, explicit fallback, argument passthrough, secret isolation, native exit codes, registration, per-turn routing, pinned tool continuations, loopback authentication/streaming, and editor routing, summary isolation, and cancellation. They do not call online services or use real keys.

Type-check and build the editor extension:

```bash
npm run check:vscode
npm run build:vscode
```

After installing the native extension, run the live integration check if needed:

```bash
npm run test:live-router
```

**This calls JEV and GitHub and consumes real usage.** It checks the native model catalog for `Desicion Router`, executes two routed turns including a native tool call, then switches to a concrete model to confirm JEV is bypassed. Its temporary project is cleaned up afterward.
