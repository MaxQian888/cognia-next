<p align="center">
  <img src="./assets/readme/workspace-cover.webp" width="100%"
       alt="Cognia：用于编程、知识工作与自动化的 AI 工作空间，支持内置和外部智能体、桌面端、浏览器、移动端与独立 CLI。">
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A526-339933?logo=node.js&logoColor=white">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white">
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-black?logo=next.js">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2.12-FFC131?logo=tauri&logoColor=black">
  <img alt="Capacitor" src="https://img.shields.io/badge/Capacitor-8-119EFF?logo=capacitor&logoColor=white">
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="#能力总览">能力总览</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#架构">架构</a> ·
  <a href="./docs/content/docs/zh/adr/">架构决策记录</a> ·
  <a href="./CLAUDE.md">工作规则</a>
</p>

**Cognia** 是用于编程、知识工作与自动化的 AI 工作空间。你可以使用内置的多提供商智能体，也可以接入 Codex、Claude Code、Gemini CLI、OpenCode 和 Pi 等外部智能体。对话、项目文件、终端、浏览器、产物和任务执行记录集中在同一工作台中。

桌面端运行本地 Rust 宿主与 Node 智能体 sidecar；浏览器和移动端可连接经过配对的宿主。独立的 `cognia-agent` CLI 支持终端对话与自动化调用，无需启动桌面窗口。各端可用功能取决于宿主能力、设备授权和插件兼容性。

> [!WARNING]
> **项目正在进行重大重构。** API、数据结构和功能随时可能变更或无法正常工作，现阶段**不保障可用性**。依赖 Cognia 时，应固定到经过验证的可用提交。

## 能力总览

以下图片基于 Cognia 原有美术制作，用于说明功能概念，并非产品界面截图。

### 使用智能体处理项目与知识

<p align="center">
  <img src="./assets/readme/context-and-twin.webp" width="100%"
       alt="Cognia 角色面对数字分身镜像，对话与文档连接到记忆面板。">
</p>

- **选择执行智能体**：为每个对话选择 Cognia 内置运行时、已配置的外部智能体或配对宿主上的智能体配置。内置运行时根据提供商使用 Claude Agent SDK 或 AI SDK。
- **在项目上下文中工作**：将对话绑定到工作区和执行目录，在工作台查看文件、Git 变更、终端、浏览器预览与生成产物。
- **复用知识与历史**：使用项目知识库、长期记忆和员工数字分身，并导入外部智能体的会话历史。技能、斜杠命令、Hooks 和模型上下文协议（MCP）扩展对话能力。

### 协调任务、团队与自动化

<p align="center">
  <img src="./assets/readme/workflow-studio.webp" width="100%"
       alt="Cognia 角色连接对话、工具、分支和文档节点，展示工作流与自动化概念。">
</p>

- **Squads 与执行管理**：组织多智能体协作，查看运行记录和任务看板，处理审批、中断与可恢复的执行。
- **目标与交付跟踪**：管理目标、问题、交付项目和周期，将规划与智能体执行关联。
- **可视化工作流**：在 React Flow 编辑器中连接执行步骤，通过定时、Webhook、连接器或对话触发任务。
- **Computer Use 与沙盒**：使用原生桌面自动化或已配置的远程桌面沙盒，通过权限检查、人工审批和审计记录控制操作。桌面端可管理 Docker 桌面沙盒，并查看和操作沙盒桌面。

### 连接设备、消息与扩展

<p align="center">
  <img src="./assets/readme/connected-devices.webp" width="100%"
       alt="Cognia 角色通过九点核心连接桌面显示器、手机与消息气泡。">
</p>

- **消息与集成**：在统一收件箱中处理已连接平台的消息，通过连接器、Bot 和插件集成外部服务。
- **设备与远程宿主**：通过局域网（LAN）或广域网（WAN）连接桌面或 headless 宿主，在设备控制台管理配对、授权与执行宿主。
- **插件与浏览器扩展**：安装工具、技能、界面、主题和工作流扩展；Chrome/Edge 伴侣扩展可将你主动选择的网页或文本发送到本机 Cognia 宿主。

<details>
<summary><strong>展开完整能力清单与技术说明</strong></summary>

<p align="center">
  <img src="./assets/readme/capabilities.svg" width="100%"
       alt="早期能力概念图：智能体对话、插件、工作流、数字分身、消息连接器、桌面自动化、OCR 与移动连接。">
</p>

当前实现包含以下能力，图中的分组仅用于说明概念：

- **智能体运行时**：内置 Claude Agent SDK 与提供商中立的 AI SDK 执行循环；外部适配器包括 Agent Client Protocol（ACP）、Codex App Server、OpenCode V2、Pi RPC、Aider CLI 和 Agent2Agent（A2A）。DeepSeek Harness 通过受管运行时接入，仍属实验功能。各适配器的模型、工具和审批能力不同。
- **模型与提供商**：配置提供商凭据、模型目录、模型选择与推理设置，查看用量和成本。外部智能体的认证及模型列表由对应运行时提供。
- **会话历史**：导入 Claude Code、Codex、OpenCode、Gemini CLI、Pi、Cursor 等来源的历史；桌面端支持扫描与监视本地历史。能否在原生运行时继续执行取决于来源、会话格式和已配置的智能体。
- **项目工作台**：浏览和编辑工作区文件，检查 Git 变更，使用终端、Monaco 或 code-server 编辑器，并查看浏览器和产物预览。文件与进程操作在所选执行宿主上完成。
- **产物与 Canvas**：查看生成的文档、代码和交互内容，在 Canvas 中编辑文档。公开分享链接使用加密内容，解密密钥保留在 URL fragment 中。
- **Squads 与运行恢复**：通过任务看板与运行控制台协调多智能体任务，保留持久化执行记录，并处理检查点、审批与中断恢复。
- **工作流、调度与 Bot**：组合智能体、工具和分支节点，配置定时及事件触发器，查看执行结果。Bot 可使用已配置的连接器和集成。
- **目标与问题跟踪**：管理目标、问题、交付项目、周期和里程碑；代码工作区与交付项目分别管理。
- **知识、记忆与数字分身**：摄取文档、检索项目知识、保存长期记忆，并将知识和风格示例用于对话。检索增强生成（RAG）与分身处理路径使用共享的个人身份信息（PII）脱敏门禁。
- **插件生态**：支持 JavaScript、Python、WASM 和兼容的 VS Code 扩展，以及角色与主题资源。插件可贡献工具、技能、MCP 配置、界面、连接器和工作流。支持 Pi 包的管理与互转；Pi 专用扩展和主题仍需 Pi 运行时，不能直接视为 Cognia 原生能力。
- **消息连接器**：`ConnectorBus` 内置 Telegram、Discord、Slack、Lark、OneBot、企业微信、钉钉、Matrix、QQ、微信公众号和个人微信适配器。统一收件箱、静默时段、熔断器与 A2UI 富内容桥由共享层管理；实际可用性取决于平台认证、权限和协议支持。
- **共享对话**：通过组织与工作区成员权限共享会话、邀请参与者并同步执行状态。需要部署协作服务，在构建时设置 `NEXT_PUBLIC_SHARED_CHAT_ENABLED=true`，并启用本机共享对话设置。
- **Computer Use、沙盒与 OCR**：使用操作系统自动化后端、远程桌面沙盒和统一 OCR 接口。Docker 沙盒、原生 OCR、录屏或浏览器控制各有运行时依赖与权限要求。
- **多端与 CLI**：Tauri 桌面端、Capacitor 移动端、浏览器伴侣、Chrome/Edge 扩展与独立 `cognia-agent` CLI。CLI 支持交互式终端、单次执行、JSON/JSONL 输出、外部智能体后端与宿主 API 调用。

实现入口与能力边界见[统一智能体执行](./docs/content/docs/zh/subsystems/unified-agent-execution/)、[插件系统](./docs/content/docs/zh/subsystems/plugin-system/)、[沙盒](./docs/content/docs/zh/subsystems/sandbox/)与 [CLI 文档](./cli/README.md)。

</details>

### 从请求到结果

<p align="center">
  <img src="./assets/readme/task-flow.svg" width="100%"
       alt="任务路径示意：带入问题、文档或对话上下文，使用 Skills、MCP、插件与工作流，最后检查回复和产出。">
</p>

**添加上下文 → 使用工具 → 检查结果。** 示意图说明各项能力如何配合，具体步骤取决于任务、已配置的工具和权限。

## 快速开始

<p align="center">
  <img src="./assets/readme/section-quickstart.svg" width="100%"
       alt="快速开始：克隆仓库、安装依赖、启动开发服务器。">
</p>

从源码安装共享依赖与 Node sidecar：

```bash
git clone https://github.com/MaxQian888/cognia-next
cd cognia-next
pnpm install
pnpm sidecars:install
```

根据使用场景选择启动方式：

| 场景                         | 命令                                                | 执行位置                                                         |
| ---------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| 桌面工作空间                 | `pnpm tauri dev`                                    | 本机 Rust 宿主与 Node sidecar；同时启动前端开发服务器            |
| 浏览器界面开发               | `pnpm dev`                                          | `http://localhost:3000`；单独启动界面不会启动原生宿主            |
| 浏览器连接本机 headless 宿主 | `pnpm dev:web-headless`                             | 启动前端、`cognia-server` 与工作区浏览器运行时；首次使用仍需配对 |
| 独立终端智能体               | `pnpm cli:dev chat`                                 | CLI 直接启动运行时，无需桌面窗口                                 |
| iOS 应用                     | `pnpm mobile:sync:ios`，然后 `pnpm mobile:open:ios` | 移动目标构建与 Xcode 项目                                        |
| Android 实时开发             | `pnpm mobile:dev:android`                           | 移动开发服务器与已授权 Android 设备                              |
| Android 离线包               | `pnpm mobile:build:android`                         | 完整移动目标构建与调试 APK                                       |

桌面端和 headless 启动流程会编译 Rust 宿主，首次构建需要下载工具和资源。`dev:web-headless` 默认只允许配对客户端访问本仓库目录；使用 `--workspaces-dir PATH` 指定其他允许的目录。命令用途和平台前置条件见下表及 [CLI 文档](./cli/README.md)、[移动端文档](./mobile/README.md)。

**源码开发要求**

| 目标                   | 要求                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| 共享前端与 CLI         | Node.js ≥ 26；使用 `package.json` 指定的 pnpm 11.18.0                                                    |
| 桌面端与 headless 宿主 | 共享工具、Rust ≥ 1.96，以及平台 C/C++ 工具链（[Tauri 前置要求](https://tauri.app/start/prerequisites/)） |
| iOS                    | 共享工具、Xcode 26+ 和 CocoaPods                                                                         |
| Android                | 共享工具、JDK 21 与 Android SDK；Android Studio 可用于管理工具链                                         |
| 可选能力               | Docker 用于本地桌面沙盒；外部智能体需要对应运行时及认证；WebRTC 中继需要 TURN 配置                       |

首次启动后，完成以下配置：

1. 完成引导，配置模型提供商的认证和默认模型，或选择已认证的外部智能体。桌面引导可扫描已有配置，并按你的选择导入历史。
2. 在浏览器或移动端选择独立模式或宿主连接模式。独立模式使用你配置的提供商凭据，受浏览器跨域访问（CORS）和工具兼容性限制；访问宿主文件和启动外部智能体进程需要可用的执行宿主；网络协议智能体则取决于对应端点的要求。
3. 使用宿主连接模式时，通过设备配对流程连接宿主，并按任务需要授予权限。聊天授权与外部智能体的 Agent Control 授权分别管理；宿主离线或授权缺失时，界面会提示恢复路径。
4. 选择代码工作区与对话运行时，再启用任务需要的插件、技能、MCP 服务或连接器。扩展不会因为被发现就自动获得执行权限。

根目录的 `prepare` 脚本自动配置 Husky 钩子。

<details>
<summary>可选：macOS Agent 强制代理</summary>

**Agent 强制代理（macOS）**：启动支持 HTTP 代理变量的 CLI Agent。Seatbelt 将 Agent 及其所有子进程的网络出口限制为一个本地代理端口：

```bash
AGENT_PROXY_URL=http://127.0.0.1:7890 pnpm agent:proxy -- claude
AGENT_PROXY_URL=http://127.0.0.1:7890 pnpm agent:proxy -- codex
AGENT_PROXY_URL=http://127.0.0.1:7890 pnpm agent:proxy -- gemini
AGENT_PROXY_URL=http://127.0.0.1:7890 pnpm agent:proxy --check
```

启动器同时设置大小写形式的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `ALL_PROXY`，并清空 `NO_PROXY`。它会验证 HTTP CONNECT 隧道，确认另一个本地端口已被阻断。不读取代理变量的 Agent 无法回退到直连。可通过 `AGENT_PROXY_CHECK_TARGET=host:port` 修改支持 TLS 的预检目标。启动器拒绝 SOCKS 和远程代理端点。

</details>

## 架构

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%"
       alt="架构示意：浏览器、Tauri 桌面端和 Capacitor 移动端共用 Next.js 代码库。桌面端增加 Rust 核心和 Node agent sidecar，移动端通过 LAN/WAN 连接，信令与分享服务分别部署。">
</p>

共享的 Next.js 16 应用按目标构建静态资源：Web/Tauri 与 Capacitor 使用相同的 `out/` 路径，但编译目标不同。**Tauri 2** 加载桌面资源并运行本机宿主；**Capacitor 8** 打包移动端资源，并可连接桌面或 headless 宿主。浏览器可使用独立模式，也可通过 Companion 协议连接宿主。

执行层分为以下部分：

- **Rust 宿主**：Tauri 桌面应用或无界面的 `cognia-server` 提供文件、Git、终端、设备授权、调度、向量存储、OCR、自动化与 MCP 等能力。实现拆分到 `crates/`，桌面封装与命令入口位于 `src-tauri/`。
- **智能体进程**：`sidecar/agent-host.mjs` 根据执行配置调用 Claude Agent SDK 或 AI SDK；协议适配器连接外部智能体，其中 stdio 进程在所选宿主上启动。独立 CLI 复用智能体与工具逻辑，同时维护自己的配置。
- **浏览器与编辑器运行时**：本地桌面能力或工作区运行时处理浏览器控制，code-server 与 VS Code 扩展宿主提供编辑器能力。浏览器伴侣、移动端和 Chrome/Edge 扩展不会自带桌面进程能力。
- **数据与协作**：客户端用 Dexie 保存本地数据及宿主状态镜像；Rust 宿主保存 SQLite 数据和持久化执行状态。共享对话使用协作服务管理成员权限和共享状态。

`services/` 中的服务按部署场景分别运行，例如：

- `services/workspace-runtime/`：工作区浏览器运行时。
- `services/signaling-server/`：WebRTC 信令服务，包含 axum 和 workers-rs 实现。
- `services/share-server/`：分享链接服务、加密内容存储与查看器。

`web/` 是产品网站，`docs/` 是 Fumadocs 文档站，均与根目录的应用分别构建。生产打包前，应先生成正确目标的资源。

重大架构决策记录在 [`docs/content/docs/zh/adr/`](./docs/content/docs/zh/adr/) 中。当前行为应以子系统文档为入口，并核对实现和测试；ADR 用于解释架构选择的理由。

## 开发

<p align="center">
  <img src="./assets/readme/section-development.svg" width="100%"
       alt="开发 —— 脚本、测试、覆盖率，以及桌面与移动端构建。">
</p>

在仓库根目录运行开发命令。下表列出常用命令，每个行内代码项都是一条独立命令。每次只使用一种前端启动方式；桌面开发和 `dev:web-headless` 已包含应用服务器。

| 任务                  | 命令                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| 应用                  | `pnpm dev`、`pnpm build`、`pnpm start`、`pnpm lint`、`pnpm format`、`pnpm typecheck`                    |
| 单元测试              | `pnpm test`、`pnpm test:watch`；仅在明确要求检查覆盖率时运行 `pnpm test:coverage`                       |
| 桌面端                | `pnpm tauri dev`、`pnpm tauri build`、`pnpm tauri info`                                                 |
| Headless 与浏览器宿主 | `pnpm dev:headless`、`pnpm dev:web-headless`、`pnpm dev:workspace-runtime`                              |
| 独立 CLI              | `pnpm cli:dev chat`、`pnpm cli:build`、`pnpm cli:test`、`pnpm cli:api:check`                            |
| 移动端构建与同步      | `pnpm mobile:sync:ios`、`pnpm mobile:sync:android`                                                      |
| 移动端 IDE            | `pnpm mobile:open:ios`、`pnpm mobile:open:android`                                                      |
| Android 开发与 APK    | `pnpm mobile:dev:android`、`pnpm mobile:build:android`、`pnpm mobile:deploy`、`pnpm mobile:deploy:fast` |
| 文档站，端口 3001     | `pnpm docs:dev`、`pnpm docs:build`                                                                      |
| 产品网站，端口 3002   | `pnpm web:dev`、`pnpm web:build`                                                                        |
| Chrome/Edge 扩展      | `pnpm browser-ext:build`                                                                                |
| Sidecar               | `pnpm sidecars:install`、`pnpm sidecar:start`、`pnpm sidecar:test`、`pnpm sidecars:build`               |
| E2E                   | `pnpm test:e2e`、`pnpm test:e2e:workflows`、`pnpm test:e2e:mobile`、`pnpm test:e2e:tauri`               |
| 仓库检查              | `pnpm audit:slots`、`pnpm i18n:build:check`、`pnpm lint:i18n`、`pnpm webrtc:smoke`                      |

完整脚本清单见 [`package.json`](./package.json)。

**测试**：将 `*.test.ts(x)` 放在源码旁。Rust 单元测试使用文件内的 `#[cfg(test)]` 模块，集成测试位于 `src-tauri/tests/`。sidecar 使用 Node 内置测试运行器（`pnpm sidecar:test`）。E2E 使用 Playwright，包含移动端和 Tauri 项目；Tauri 项目运行真实调试包。覆盖率检查按需执行；明确要求检查时，使用 `pnpm test:coverage`，目标为行、分支和函数覆盖率 ≥ 90%。

**提交钩子**：`pre-commit` 通过 `lint-staged` 运行 `eslint --fix` 和 `prettier --write`；`commit-msg` 通过 `commitlint` 校验 Conventional Commits。钩子失败时，修复原因、重新暂存相关文件，并创建**新提交**。禁止通过 `--no-verify` 绕过钩子。

**构建**：`pnpm build` 将 Web/Tauri 静态导出保存到 `out/`，`pnpm tauri build` 生成桌面安装包。移动端同步命令使用移动编译目标，再由 Xcode 或 Android Studio 签名和归档。默认桌面构建启用 `ocr-paddle`；其他原生 OCR 后端取决于 Cargo 特性（`ocr-tesseract`、`ocr-windows`、`ocr-ocrs`）和运行时前置条件。macOS 上的 Apple Vision 无需额外启用特性。

## 参考

<p align="center">
  <img src="./assets/readme/section-reference.svg" width="100%"
       alt="参考 —— 配置、项目结构、技术栈与关键说明。">
</p>

### 项目结构

```text
cognia-next/
├── app/                   Next.js App Router（静态导出）
├── components/            React 组件（ui/ = shadcn，ai-elements/ = 内嵌）
├── hooks/  lib/  types/   业务逻辑、Hook、共享类型
├── plugins/               内置第一方插件
├── packages/             共享 SDK 与业务包（agent、plugin-sdk、provider-* 等）
├── crates/               Rust 宿主、协议、安全与运行时实现
├── cli/                  cognia-agent 独立终端 / headless 智能体
├── browser-extension/    Chrome/Edge 网页伴侣扩展
├── web/                  产品网站（workspace 子包，端口 3002）
├── i18n/                  next-intl request + messages（en、zh-CN）
├── src-tauri/             Tauri 2 Rust 核心（axum HTTP、调度器、自动化、OCR、…）
├── sidecar/               Node 智能体 / 扩展宿主；独立依赖与 lockfile
├── mobile/                Capacitor 8 外壳（workspace 子包）
├── docs/                  Fumadocs 站点 + ADR（workspace 子包，端口 3001）
├── services/              独立部署的服务
│   ├── workspace-runtime/ 工作区浏览器运行时
│   ├── signaling-server/  WebRTC 信令汇合服务（axum + workers-rs）
│   └── share-server/      Cloudflare Worker + Vite 查看器，承载分享链
├── tests/e2e/             Playwright 套件（workflows、mobile、tauri）
└── scripts/               构建、审计、迁移辅助
```

### 配置

- **环境变量**：运行 `cp .env.example .env.local`。`NEXT_PUBLIC_*` 变量对浏览器可见，`lib/env.ts` 在首次访问时校验必需值。禁止提交 `.env.local`。
- **Tauri**：`src-tauri/tauri.conf.json` 定义产品名（`Cognia`）、标识符（`com.cognia.desktop`）、深链协议（`cognia://`）、内容安全策略（CSP）、自定义标题栏和随包提供的 sidecar 资源。
- **路径别名**：使用 `@/components`、`@/lib`、`@/ui`、`@/hooks` 和 `@/utils`。
- **样式**：通过 `@tailwindcss/postcss` 使用 Tailwind v4，采用 oklch CSS 变量和基于类的暗色模式（`@custom-variant dark (&:is(.dark *))`）。

### 技术栈

| 分层            | 主要技术                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| 前端            | Next.js 16、React 19、TypeScript、Tailwind v4、shadcn/ui（`new-york`）、Radix UI、`next-intl`                     |
| 状态 / 数据     | Zustand 5、Dexie 4 + `dexie-react-hooks`、`zundo`、React Hook Form、Zod 4                                         |
| 编辑器 / 可视化 | React Flow、Monaco、CodeMirror、Mermaid、KaTeX、three / r3f、Recharts、`motion`                                   |
| AI              | Claude Agent SDK、Vercel AI SDK v7、`@ai-sdk/*`、MCP、ACP、Codex App Server、OpenCode V2、Pi RPC                  |
| 桌面核心        | Tauri 2.12、Rust 1.96+、`axum`、`tokio`、`rusqlite` + `sqlite-vec`、`webrtc-rs`、`wasmtime` 49、`keyring`、`git2` |
| 移动端          | Capacitor 8（iOS / Android）、条码扫描、生物识别 / 安全存储 / 录音插件                                            |
| Sidecar         | Node 26+ ESM / TypeScript、智能体宿主、VS Code 扩展宿主、网页快照与编辑器桥                                       |
| 终端与扩展      | Ink / React TUI、WXT 浏览器扩展、JavaScript / Python / WASM 插件运行时                                            |
| 质量            | Jest 30 + RTL、Playwright、ESLint 9、Prettier 3、Husky + lint-staged + commitlint                                 |

### 关键说明

- **包管理器**：在仓库根目录使用 `package.json` 指定的 pnpm 版本安装依赖，并保留 `pnpm-lock.yaml`。
- **静态导出**：保留 `next.config.ts` 中生产构建的 `output: "export"`。Tauri 和 Capacitor 均使用 `out/`，但需要各自的编译目标。文档站在 `docs/next.config.ts` 中单独配置静态导出。
- **HTTP 服务**：应用运行时没有 `app/api/` 服务。MCP、Webhook 接收和 Companion API 等能力由桌面或 headless 宿主提供；工作区浏览器等服务分别运行。
- **浏览器依赖**：Node 专用操作必须位于浏览器包之外。`next.config.ts` 通过 `NODE_ONLY_MODULES` 和浏览器桩处理第三方依赖引用的 Node 内置模块。扩展别名时，同时检查 Turbopack 和 Webpack 的处理方式。

### 约定

遵循 [`AGENTS.md`](./AGENTS.md) 中的项目规则，以及 [`CLAUDE.md`](./CLAUDE.md) 中的开发指南：

1. **先研究，再实现。** 添加工具、Hook 或组件前，先在 `lib/`、`components/`、`hooks/`、`src-tauri/` 和相关 ADR 中查找已有实现，优先扩展现有模块。
2. **完整实现需求。** 阻塞导致无法完成时，明确说明原因，禁止静默省略必要行为。
3. **测试与源码同位放置。** `components/**`、`hooks/**`、`lib/**` 和 `src-tauri/src/**` 下新增或修改的文件需要同位测试。内嵌的 `components/ui/` 和 `components/ai-elements/` 目录除外。覆盖率检查需要明确要求。
4. **用户可见文本必须接入 i18n。** `.tsx` 中禁止硬编码字符串。在 `i18n/messages/en/**` 和 `i18n/messages/zh-CN/**` 两套拆分源文件中添加键，然后运行 `pnpm i18n:build`、`pnpm i18n:build:check` 和 `pnpm lint:i18n`。禁止直接编辑生成的 `i18n/messages/en.json` 或 `i18n/messages/zh-CN.json`。
5. **复用共享模块。** PII 脱敏（`packages/redact/src/index.ts`）、静默时段控制（`lib/connectors/outbound-runner`）、构建选项管道（`lib/claude/build-options.ts`）和 A2UI ⇄ IM 桥（`lib/connectors/a2ui-bridge/`）均已有共享入口，应扩展这些入口，避免重复实现。

### 故障排除

| 现象                                               | 下一步                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 端口 3000 已占用                                   | 确认占用进程，仅在可以安全停止时关闭它；或使用 `pnpm dev --port 3002`。                                                         |
| Tauri 构建失败                                     | 运行 `pnpm tauri info`，再根据构建错误检查平台前置条件。                                                                        |
| 缺少模块                                           | 在根目录运行 `pnpm install --frozen-lockfile`。sidecar 依赖使用 `pnpm sidecars:install`，保留锁文件。                           |
| 文档提示 `Cannot find module 'collections/server'` | 运行 `pnpm docs:dev`，生成 `docs/.source/`。                                                                                    |
| i18n 检查失败                                      | 运行 `pnpm i18n:build`、`pnpm i18n:build:check` 和 `pnpm lint:i18n`，修复报告的源文件或语言键差异；禁止仅为消除报错而重置基线。 |
| 缺少 Monaco 资源                                   | 运行 `pnpm monaco:copy`；`predev` 和 `prebuild` 也会执行此步骤。                                                                |
| 浏览器或移动端无法发送，或提示需要配对             | 检查所选宿主是否在线、配对凭据是否可用及聊天授权是否已授予。`pnpm dev` 只启动界面；需要本机宿主时使用 `pnpm dev:web-headless`。 |
| 外部智能体无法启动                                 | 检查运行时安装、版本、认证与所选执行宿主；配对客户端还需 Agent Control 授权。按智能体设置页的检测结果处理。                     |
| 插件被发现但无法启用                               | 查看插件兼容性与权限诊断。原生插件不能直接在未连接宿主的浏览器或移动端运行；Pi 专用资源需要对应运行时。                         |
| Android 快速部署拒绝已有资源                       | 资源已过期、被修改或不是移动目标；重新运行 `pnpm mobile:build:android`，再执行部署。                                            |

## 贡献

1. Fork 仓库，创建功能分支 `<type>/<short-kebab>`（例如 `feat/connector-wecom`）。
2. 保持改动范围集中，并遵循[约定](#约定)。
3. 同步添加或更新同位测试。
4. 运行 `pnpm lint`、`pnpm typecheck`、`pnpm test` 与相关的 `pnpm test:e2e:*`。
5. 使用 Conventional Commits 提交，PR 中关联相关 ADR 并说明验证结果。

## 了解更多

- **ADR**：[`docs/content/docs/zh/adr/`](./docs/content/docs/zh/adr/)（运行 `pnpm docs:dev` 后访问 <http://localhost:3001>）
- **独立智能体 CLI**：[`cli/README.md`](./cli/README.md)
- **智能体执行与恢复**：[`unified-agent-execution/`](./docs/content/docs/zh/subsystems/unified-agent-execution/)
- **移动端工作流**：[`mobile/README.md`](./mobile/README.md)
- **浏览器伴侣扩展**：[`browser-extension/`](./browser-extension/)
- **插件 SDK**：[`packages/plugin-sdk/`](./packages/plugin-sdk/)
- **工作规则**：[`CLAUDE.md`](./CLAUDE.md)
- **外部文档**：[Tauri 2](https://tauri.app/) · [Next.js 16](https://nextjs.org/docs) · [shadcn/ui](https://ui.shadcn.com/) · [Capacitor](https://capacitorjs.com/docs) · [Fumadocs](https://fumadocs.dev/)

## 许可证

[AGPL-3.0-or-later](./LICENSE)。

## 支持

- 阅读 [`docs/content/docs/zh/adr/`](./docs/content/docs/zh/adr/) 下对应 ADR。
- 在[问题跟踪器](https://github.com/MaxQian888/cognia-next/issues)中说明问题和复现步骤。
