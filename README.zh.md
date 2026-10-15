# Decision Router：GitHub Copilot 模型路由

[English](README.md) | [简体中文](README.zh.md)

[项目仓库：kinfey/decision-ghc-router](https://github.com/kinfey/decision-ghc-router)

**JEV 判断，GitHub Copilot 执行**。支持 CLI 原生 `/model` 菜单中的 **Decision Router**、VS Code / Insiders 聊天模型菜单中的 **decision-router**，以及启动前一次性选模。不修改登录凭据或全局默认模型，不额外调用 Copilot 做分类。

判断后端同时支持 **TypeSafe API** 和 **Azure Decision-1**。所选后端仅负责选模，任务仍由账号可用的 GitHub Copilot 模型执行。

```text
原生 /model -> Decision Router -> 每个新用户回合调用 JEV
                           -> 本地回环代理 -> 账号允许的 GitHub 推理模型
原生 /model -> 具体模型   -> 原生 Copilot 直接执行，不调用 JEV
```

## 前置条件与配置

要求 Node.js 22.16+、已安装 GitHub Copilot CLI，并已通过 `copilot login` 登录具有相应模型权限的账号。编辑器集成要求 VS Code / Insiders 1.140+，并在对应编辑器中登录 GitHub Copilot。

在项目根目录执行：

```bash
npm install

# 仅在 .env 不存在时复制示例，然后填写自己的 JEV key。
cp -n .env.example .env
chmod 600 .env
```

不要覆盖已有 `.env`，也不要提交或分享密钥。npm 使用项目 `.npmrc` 中配置的 Microsoft 源 `https://packagefeedproxy.microsoft.io/npm/`。

## 在原生 `/model` 中选择 Decision Router

安装用户级扩展（可重复执行）：

```bash
npm run install:router

# 在本项目启动原生 CLI；自动打开所需实验性接口，但不自动授予工具权限。
npm run router
```

安装后重启 CLI，并批准工作目录信任及 `user:decision-router` 的 **register hooks** 权限；未批准时菜单项可能不会加载。进入 CLI 后输入 `/model`，选择 **Decision Router**。内部模型 ID 是 `decision/router`，模型显示名是 `Decision Router`。也可以用原生命令 `/model decision/router` 选择它。每个新的用户回合会显示实际执行模型，例如：

```text
JEV -> gpt-6-luna (jev, confidence 0.98); estimated $0.002000.
```

扩展安装到 `~/.copilot/extensions/decision-router/extension.mjs`（如果设置了 `COPILOT_HOME`，则使用该目录）。在**其他项目**运行原生 CLI：

```bash
cd /path/to/project
COPILOT_ALLOW_GET_PROVIDER_ENDPOINT=true copilot --experimental
# 然后在 /model 中选择 Decision Router
```

`--experimental` 启用原生扩展接口；`COPILOT_ALLOW_GET_PROVIDER_ENDPOINT=true` 显式允许本地代理通过 SDK 获取当前账号的运行时推理端点和认证信息。不修改 shell 启动配置。普通 `copilot` 如果没有开启这些接口，不能假定扩展能加载或执行；端点接口未开启时会明确报错，不偷偷改用别的认证方式。

原生菜单仍保留账号的具体模型：选具体模型暂停 JEV，重新选 `Decision Router` 恢复。一个回合的工具循环和继承路由器的子代理请求固定使用该回合选择的模型，不重复调用 JEV。子代理明确指定原生模型时仍由原生 CLI 管理。本版本只支持默认上下文档位、文本与原生工具调用，以及 GitHub 目录中支持 `/responses` 的模型；不为图片、Anthropic Messages API 或长上下文伪造兼容能力。

代理仅监听 `127.0.0.1` 的随机端口，用随机本地凭据认证；从 SDK 获取的 GitHub 凭据只在内存中用于 HTTPS 请求 GitHub，不保存、不输出、不发送给 JEV，也不把本地代理凭据当作 GitHub 凭据转发。保留原生工具定义、工具结果、流式回复、权限和会话；不额外启动另一个模型代理循环。

**计费提醒：这是自定义 provider 注册项，不是 GitHub 官方免费模型。** 原生 CLI 可能将此项显示为 BYOK 或零倍率，`/usage` 和 `--max-ai-credits` 不一定完整跟踪代理转发产生的 GitHub AI credits；实际仍按 GitHub 账号的执行模型计费，请以 GitHub 账单为准，不将该显示或软预算视为费用保障。扩展启动时也会显示提醒。

安装入口只引用本项目的代码，不包含密钥，因此必须保留本项目目录和依赖；移动目录后重新执行 `npm run install:router`。升级到新名称时，安装器会移除本项目的旧受管入口，同时保留无关扩展。卸载时运行 `npm run uninstall:router`，只删除属于本应用的用户级入口，随后重启 Copilot。安装器不改变全局默认模型。

## VS Code 和 VS Code Insiders

此集成是独立扩展，注册到**编辑器原生聊天模型菜单**，不是集成终端里的 CLI 菜单。要求 VS Code 1.140+。

```bash
npm run check:vscode
npm run package:vscode

# macOS：分别安装到两个编辑器。
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension "$PWD/decision-router.vsix" --force
"/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
  --install-extension "$PWD/decision-router.vsix" --force
```

在两个编辑器分别运行 **Developer: Reload Window**，然后在聊天模型菜单选择 **decision-router**。如果未显示，在 **Manage Models** 中启用 **Decision Router / decision-router**。运行 **Decision Router: Configure .env** 可选择存放 TypeSafe 或 Azure 密钥的本地文件；设置只保存路径，不保存密钥，并兼容旧的 `.env` 路径设置。本地构建默认使用本项目的 `.env`，VSIX 不包含此文件，移动目录后须重新配置路径。升级时，在安装新名称的扩展后卸载旧编辑器扩展，以免出现重复模型项。

执行时，按编辑器提示批准 Copilot 语言模型访问权限。候选模型来自该编辑器登录账号的 `vscode.lm.selectChatModels({ vendor: "copilot" })`，不假定 CLI 与编辑器使用相同账号。通过精确名称匹配当前 GitHub 官方默认档价格，排除价格未知及实测输入超过默认档上下文的模型；输出估算默认 2,000 token，可通过 `.env` 中 `JEV_OUTPUT_TOKENS` 调整。公开 API 不暴露各模型输出上限，因此估算不是输出长度承诺，最终请求限制由具体模型执行。

JEV 只接收明确 `<userRequest>` 包装中的任务；无法从编辑器附加上下文中可靠提取任务时，会询问一个**只用于选模的摘要**，不自动上传附件、源码或完整对话。Copilot 收到完整对话及工具定义，编辑器继续执行原生工具；按工具调用 ID 固定后续模型，工具轮次不重复选模。取消、缺失密钥、无匹配价格、低置信度及 API 失败都会明确停止，不静默更换模型。

在 **Output → Decision Router** 查看实际选择的模型及单轮估价。该估价使用公开默认档单价，不包含促销、缓存优惠、后续工具轮次及 JEV 费用，不保证实际账单或显示为免费。此版本不支持图片或长上下文档位，且尊重组织对自定义模型提供方的限制。

## 启动前一次性选模

此模式先针对初始任务调用 JEV，再使用选定的具体模型启动原生 CLI；后续回合不自动重新选模。

```bash
# 查看账号模型，按估算成本排序；不调用 JEV，不生成模型回复。
npm run models

# 只做 JEV 路由判断，不执行任务。
npm start -- route "为一个已有函数添加边界测试" --json

# 路由后打开原生交互式 Copilot CLI，并执行初始任务。
npm start -- "解释这个项目的入口"

# 非交互执行；权限完全由原生 CLI 管理。
npm start -- -p "解释这个项目的入口" -- --allow-all-tools

# 手动选模时不调用 JEV；ID 必须来自当前账号目录。
npm start -- --model gpt-6-luna -p "计算 2+2" -- --allow-all-tools

# 针对其他项目运行，保留其工作目录和原生工具。
npm start -- -C /path/to/project "修复失败的测试"
```

也可执行 `node bin/jev-copilot.mjs`；无参数运行时会询问初始任务。需要全局命令时在本目录执行 `npm link`，之后使用 `decision-router "任务"`。旧全局命令保留为兼容别名，现有 `JEV_*`、TypeSafe 及 Azure 环境配置保持不变。

原生 CLI 参数放在 `--` 后，例如 `--deny-tool=shell`、`--resume=<session-id>`、`--max-ai-credits=30`（当前 CLI 最小值为 30）。启动器**不会自动授予工具权限**。`--model`、`--context`、`-p`、`-i`、`-C` 必须使用启动器选项，不能放在透传区域；不支持绕过路由的 `--agent`、`--fleet`、`--connect`、`--acp`。

## 最低成本策略

启动前模式通过 Copilot SDK 的 `getAuthStatus()` 和 `listModels()` 读取登录账号目录；原生菜单模式则使用所加入会话的 `session.rpc.model.list()`，沿用该会话的账号、集成和权限，并兼容实时目录的 snake_case / camelCase 价格形状。只将允许使用、具有有效实时价格、能容纳估算输入/输出的**具体模型**交给 JEV。自动排除 `auto`、隐藏、被禁用/尚未配置的模型、价格未知及上下文不足的模型，不硬编码账号权限或假定某个厂商可用。原生菜单模式额外过滤不支持 `/responses` 的候选模型，具体模型的原生选择不受此过滤影响。

JEV 的目标是“**能一次完成任务的最便宜模型**”，不是所有任务一律使用最弱模型；难任务仍可能选择高价模型。因此不能保证实际总成本的数学最小值。

CLI 模式的价格依据 [GitHub 模型计费文档](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)，运行时以账号目录的 `billing.tokenPrices` 为准，不使用旧的 premium-request 倍率进行估价。编辑器模式使用当前官方公开默认档价格表：

```text
1 AI credit = $0.01
估算 USD = (输入 token 数 × inputPrice + 输出 token 数 × outputPrice)
           / batchSize / 100
```

`inputPrice` / `outputPrice` 的单位是每个计费批次的 **AI credits**，不能直接当美元。输出同时显示缓存读取/写入单价；基础估算按未缓存输入计算，不计缓存读写、额外工具轮次、隐藏上下文、重试或 JEV 自身费用，也不代表订阅额度之外一定会产生同额账单。JEV 费用以 TypeSafe 的实际套餐为准。

价格示例：假设某个可用模型的默认档输入价格为 **$0.10 / 百万 token**、输出价格为 **$0.50 / 百万 token**，则 10,000 输入 + 2,000 输出的估价为 **$0.002**。这不是固定价格或账号默认模型；运行时始终重新发现可用模型和价格。

启动前模式默认传递 `--context default`，不自动开启长上下文；显式使用 `--context long_context` 时，使用该模型长上下文价格并过滤不支持该档位的模型。估算输入超过默认档阈值时，不会悄悄按便宜档计价。`Decision Router` 原生菜单项当前不支持长上下文，统一发布 128,000 输入 / 16,000 输出的保守上限。

```bash
npm start -- route "你的大上下文任务" \
  --input-tokens 300000 --output-tokens 4000 --context long_context
```

这些 token 数是**用户估算**，不是 tokenizer 测量或实际限制。选模逻辑不读取仓库内容、附件或已有会话上下文，因此恢复会话时应自行提供合理估算。原生 CLI 的 `--max-ai-credits` 不是严格的账单上限，尤其不能依赖它约束 `Decision Router` 自定义 provider 的真实费用。

## `.env`

```dotenv
JEV_PROVIDER=typesafe
JEV_API_KEY=your_jev_api_key
COPILOT_CLI_PATH=copilot
JEV_INPUT_TOKENS=10000
JEV_OUTPUT_TOKENS=2000
JEV_FALLBACK_CHEAPEST=0
```

使用 Azure 判断后端时，在本地 `.env` 设置：

```dotenv
JEV_PROVIDER=azure
AZURE_DECISION_ENDPOINT=https://<your-resource>.services.ai.azure.com/providers/microsoft/v1/systemone
AZURE_DECISION_API_KEY=your_azure_api_key
AZURE_DECISION_MODEL=Decision-1
```

请填写自己的端点和模型部署名；默认部署名为 `Decision-1`。Azure 请求向配置的完整端点发送同样的类型化 `state` / `questions` 选择题结构，并添加 `model`，通过 `api-key` 请求头认证。必须使用 HTTPS，且禁止重定向。Azure 和 TypeSafe 密钥独立，切换后端不会静默回退到另一服务。未设置 `JEV_PROVIDER` 时仍默认使用现有 TypeSafe 配置。

该配置同时适用于启动前选模、CLI 原生菜单扩展和两个编辑器扩展。更新已安装扩展后，请重启 CLI 或重新加载编辑器窗口。Azure 判断服务与 Copilot 执行分别计费，TypeSafe 判断服务亦如此。

CLI 优先级：进程环境变量 > 目标项目的 `.env`（启动前模式可通过 `-C` 指定）> 启动器目录的 `.env`。同时兼容 `TYPESAFE_API_KEY`。编辑器读取 `decisionRouter.envFile` 指定的文件，未配置时使用构建项目的 `.env` 路径；进程环境变量优先于该文件。编辑器模式会统计输入 token，并将 `JEV_INPUT_TOKENS` 用作估算下限，输出估算不得超过 16,000 token。

JEV 单次请求超时 4 秒，总取消信号 5 秒，不自动重试，避免重复费用。超时、无效选择或置信度低于 0.3 时默认报错退出，不擅自启动高价模型。CLI 模式可显式设置 `JEV_FALLBACK_CHEAPEST=1`：此时会发出警告并使用最低估算价模型，但**不保证能胜任任务**。编辑器模式不使用此降级选项，路由失败时停止执行。

`.env` 已被 `.gitignore` 排除；不要提交、分享或放入前端。启动器会从 Copilot 子进程中剥离 JEV/TypeSafe 和 `AZURE_DECISION_*` 环境变量，错误信息会脱敏。扩展从配置文件读取密钥；若使用环境变量覆盖配置，会通过 SDK 显式请求访问判断后端配置及密钥，原生 CLI 可能要求批准。原生 Copilot 的文件工具仍有可能读取工作目录中的 `.env`；这不是文件访问隔离方案。不要在任务里要求读取或上传密钥文件。已在聊天或公开位置暴露过的 key 建议轮换。

## 边界

原生菜单模式是真实注册的 `Decision Router` 提供方，按新用户回合路由；启动前模式仍然只在启动时路由一次，后续不自动重新判断。手动切换到具体模型后，之前的估算不再代表新模型费用。

CLI 自动路由会向所选判断后端发送当前用户回合的原始任务文本、候选模型名称/价格及 token 估算：TypeSafe 使用 `https://api.typesafe.ai`，Azure 使用配置的端点。不自动读取并发送仓库文件或完整历史，也不发送 GitHub 凭据；若任务自身包含敏感内容，这些内容也会发送。CLI 原生菜单模式通过本地代理将完整模型请求发送给 SDK 指定的 GitHub 推理端点。编辑器模式通过公开 Copilot 语言模型 API 执行，向判断后端发送可提取的任务或用户明确输入的摘要。`route` 同样会调用判断服务，可能产生费用；`models` 和手动选择具体模型不调用判断服务。

## 开发

```bash
npm test
```

离线测试覆盖两种目录价格形状、计费单位、价格排序、目录过滤、上下文阈值、无效/低置信度判断、显式失败降级、参数透传、密钥隔离、原生进程退出码、模型注册、逐轮路由、工具循环固定模型、本地代理认证/流式转发，以及编辑器路由、摘要隔离和取消。测试不调用在线服务，不使用真实 key。

编辑器扩展的类型检查与构建：

```bash
npm run check:vscode
npm run build:vscode
```

已安装扩展后可以运行端到端验证（会实际调用 JEV 和 GitHub 并产生少量用量）：

```bash
npm run test:live-router
```

它在临时项目中确认真实菜单目录包含 `Decision Router`，切换到路由器执行两个回合（含一次原生工具调用），再切换到具体模型确认 JEV 暂停，结束后清理临时目录。
