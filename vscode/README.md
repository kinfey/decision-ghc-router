# Desicion Router

Adds **desicion-router** to the native VS Code and VS Code Insiders chat model picker.
Set `JEV_PROVIDER=typesafe` (default) or `JEV_PROVIDER=azure` in your selected
`.env`. Azure requires `AZURE_DECISION_ENDPOINT` (the full HTTPS systemone URL),
`AZURE_DECISION_API_KEY`, and optionally `AZURE_DECISION_MODEL` (default:
`Decision-1`). Both backends classify the task; Copilot still executes it.
JEV chooses a low-cost sufficient model from the Copilot models available to the
account signed in to that editor. Execution uses the editor's public Copilot
language-model API; no CLI inference credentials are copied.

After installation, reload the editor window. If necessary, open **Manage Models**
in the chat model picker and enable `desicion-router` under **Desicion Router**.
Run **Desicion Router: Configure .env** to select a local file containing your chosen backend's credentials.
Only the file path is saved in settings. The locally built package defaults to the
build project's `.env`; it never includes that file or its key.

On execution, approve Copilot language-model access if VS Code asks. JEV receives
only the task in an unambiguous `<userRequest>` wrapper or a summary you explicitly
enter. If the task cannot be isolated from editor context, the extension asks for
a summary rather than uploading attachments or repository context to JEV.
Copilot receives the full conversation and native tool definitions. Tool results
are pinned to the model that emitted their call IDs; VS Code invokes the tools.

Open the **Desicion Router** output channel to see the selected model and estimated
cost. Prices come from the current public GitHub default-context price table.
Unknown-price models and insufficient-context models are excluded. Estimates
exclude promotions, cached-token discounts, JEV fees, and subsequent tool rounds.
Actual Copilot charges still apply; the router's displayed accounting is not a
guarantee of total cost or free BYOK usage.

Images and long-context pricing are unsupported. Cancellation and routing failures
stop execution; there is no silent model substitution. Administrator restrictions
on custom providers or Copilot model access are respected.
