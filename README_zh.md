# Cognia

Cognia 是面向 Claude Code 的 AI 桌面客户端，同时也是插件、可视化工作流、员工数字分身、平台连接器、Computer Use 自动化、OCR 和广域网级移动伴侣访问的运行时。同一份 Next.js 16 静态导出驱动三种外壳：浏览器开发服务器、Tauri 2.9 桌面应用和 Capacitor 7 移动应用外壳，所有外壳共享 Rust 核心和 Node sidecar。

[English Documentation](./README.md) · [架构决策记录 (ADR)](./docs/content/docs/zh/adr/) · `productName`：**Cognia** · `identifier`：`com.reactquickstarter.desktop`

## 亮点

- **插件平台** —— 内置 16 个一等公民插件：Computer Use、GitHub Delivery、OCR、剪贴板、截图、Web Tools、Prompt 模板、Anthropic Skills、Stagehand、Playwright MCP、e2b 沙盒等。WASM 插件运行时基于 `wasmtime` 26 + WIT 绑定。
- **可视化工作流编辑器** —— 基于 React Flow，包含 38 种节点类型和 32 个执行器；TypeScript + Rust 混合运行时；支持 cron / webhook / 连接器 / 聊天触发；具备团队感知的并发调度器和预算守卫。
- **员工数字分身（Digital Twin）** —— 7 阶段摄取 → 5 智能体蒸馏 → 运行时 RAG + 风格 few-shot，全程经过 PII 脱敏闸门。
- **平台连接器** —— Telegram / Discord / Slack / Lark / OneBot，共享 ConnectorBus、出站执行器（静默时段、熔断、幂等）以及按平台自动降级富内容的 A2UI ⇄ IM 桥。
- **Computer Use** —— 将 Anthropic 原生工具调用分派到各平台自动化后端（Windows UIA、macOS AX、Linux AT-SPI），具备三级权限模型和 HITL（人机协同）确认遮罩。
- **OCR 子系统** —— 17 个提供商（4 个云文档、3 个 LLM 视觉、4 个专用、Lark、5 个本地 —— Tesseract、Windows.Media.Ocr、Apple Vision、ocrs、PaddleOCR PP-OCRv5）统一在 `extract()` API 之下，配合 Dexie 结果缓存。
- **统一订阅模块** —— 一个提供商 trait，三种实现（Claude PKCE / Codex 设备码 / OpenCode 粘贴 Zen Key），支持多账号金库与加密导入导出。
- **广域网移动传输** —— Capacitor 移动端通过 LAN/HTTPS 连接，配合 mDNS 发现、JWT 配对，以及可选的 WebRTC DataChannel 层（独立信令服务器 + TURN BYO）。
- **GitHub Delivery** —— 将 PR Review、Issue→PR、Release 建模为受策略闸控的工作流，全程审计留痕。
- **`/goal` 命令** —— 自驱动聊天循环，7 种退出条件、PII 脱敏的裁判、`generationId` 守卫。

## 架构总览

```
┌────────────────────────────────────────────────────────────────────┐
│  Next.js 16（静态导出 → out/）◄── 三种外壳共享                       │
│  app/  components/  hooks/  lib/  plugins/  i18n/                  │
└────────────────────────────────────────────────────────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
   浏览器 dev            Tauri 2.9 桌面             Capacitor 7
   (pnpm dev)            (src-tauri/，Rust          (mobile/，包裹
                          核心 + axum HTTP +         ../out，作为
                          调度器 + 连接器 +          headless 服务器
                          自动化 + OCR + 向量        的 LAN / 隧道
                          数据库)                    客户端)
                              │
                              ▼
                      Node sidecar (sidecar/)
                      • claude-host.mjs (Claude Code SDK 宿主)
                      • a2ui-mcp.mjs   (A2UI 桥 MCP 服务器)
                      • dispatch/, builtin-tools/
                      • 随桌面应用打包
```

另有独立的 `signaling-server/` 包，作为可选 WAN 传输的 WebRTC 信令汇合服务。

## 子系统一览

每行都对应一份完整的 ADR，位于 `docs/content/docs/zh/adr/` —— 做非平凡改动前请先读对应 ADR。

| 子系统                                                                    | 所在目录                                                                                       | ADR                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据备份 / 传输（`BackupPackageV3`、AES-GCM 信封、定时备份）              | `lib/data/`, `components/settings/data/`, `lib/db/backup-history.ts`                           | [0001](./docs/content/docs/zh/adr/0001-backup-schema-v3.md)                                                                                                                                                                                                                |
| 调度器全 Agent 解析                                                       | `src-tauri/src/scheduler/`, `lib/scheduler/`                                                   | [0002](./docs/content/docs/zh/adr/0002-scheduler-full-agent-resolution.md)                                                                                                                                                                                                 |
| 员工数字分身（摄取 → 蒸馏 → 运行时 RAG，PII 脱敏）                        | `lib/twin/`, `types/twin/`, `components/twin/`, `app/twin/`                                    | [0003](./docs/content/docs/zh/adr/0003-employee-digital-twin.md)                                                                                                                                                                                                           |
| 原生向量后端（sqlite-vec）+ Rust 云后端                                   | `src-tauri/src/vector/`, `lib/vector/`                                                         | [0004](./docs/content/docs/zh/adr/0004-vector-native-backend.md)                                                                                                                                                                                                           |
| 远程控制与伴侣 API                                                        | `src-tauri/src/remote_control/`, `src-tauri/src/companion_api/`                                | [0005](./docs/content/docs/zh/adr/0005-remote-control.md)                                                                                                                                                                                                                  |
| 插件系统（清单、插槽、Dexie 表、WASM 运行时）                             | `plugins/`, `lib/plugin/`, `src-tauri/src/plugin_api/`                                         | [0006](./docs/content/docs/zh/adr/0006-plugin-system.md)、[0013 (WASM)](./docs/content/docs/zh/adr/0013-wasm-plugins.md)、[0016](./docs/content/docs/zh/adr/0016-plugin-system-completion.md)、[0017](./docs/content/docs/zh/adr/0017-workflow-plugin-extension-points.md) |
| External Bridge（wiki 索引器 + MCP 服务器：4 工具 / 3 资源族）            | `lib/external-bridge/`, `lib/wiki/`, `src-tauri/src/mcp_server/`                               | [0008](./docs/content/docs/zh/adr/0008-external-bridge.md)                                                                                                                                                                                                                 |
| 平台连接器（Telegram/Discord/Slack/Lark/OneBot）+ A2UI ⇄ IM 桥            | `lib/connectors/`, `app/inbox/`, `src-tauri/src/connectors/`, `src-tauri/src/a2ui_bridge/`     | [0009](./docs/content/docs/zh/adr/0009-platform-connectors.md)                                                                                                                                                                                                             |
| 统一订阅模块（Claude / Codex / OpenCode）                                 | `lib/subscription/`, `src-tauri/src/subscription/`, `components/settings/subscription/`        | [0010](./docs/content/docs/zh/adr/0010-claude-subscription-oauth.md)                                                                                                                                                                                                       |
| 可视化工作流（React Flow 编辑器 + TS/Rust 混合运行时）                    | `lib/workflow/`, `types/workflow/visual.ts`, `components/workflow/`, `src-tauri/src/workflow/` | [0011](./docs/content/docs/zh/adr/0011-workflows-subsystem.md)                                                                                                                                                                                                             |
| 传输抽象                                                                  | `lib/tauri/transport-*.ts`                                                                     | [0012](./docs/content/docs/zh/adr/0012-transport-abstraction.md)                                                                                                                                                                                                           |
| 命令清单                                                                  | `lib/slash-commands/`, `lib/skills/`                                                           | [0013](./docs/content/docs/zh/adr/0013-command-manifest.md)                                                                                                                                                                                                                |
| Capacitor 移动外壳 + V2 headless 服务器                                   | `mobile/`, `lib/mobile/`, `lib/api/v1/`, `src-tauri/src/bin/cognia-server.rs`                  | [0014](./docs/content/docs/zh/adr/0014-capacitor-mobile-shell.md)、[0015](./docs/content/docs/zh/adr/0015-mobile-v2-completion.md)                                                                                                                                         |
| GitHub Delivery（PR Review / Issue→PR / Release 策略闸控工作流）          | `lib/github/`, `plugins/github-delivery/`                                                      | [0018](./docs/content/docs/zh/adr/0018-github-delivery.md)                                                                                                                                                                                                                 |
| `/goal` 命令（自驱动聊天循环）                                            | `lib/goal/`, `components/goal/`, `lib/slash-commands/actions/goal.ts`                          | [0019](./docs/content/docs/zh/adr/0019-goal-command.md)                                                                                                                                                                                                                    |
| Computer Use（Anthropic 原生工具 + 各平台自动化）                         | `src-tauri/src/automation/`, `lib/automation/`, `plugins/computer-use/`                        | [0020](./docs/content/docs/zh/adr/0020-computer-use-completeness.md)                                                                                                                                                                                                       |
| WebRTC DataChannel WAN 传输 + 信令服务器                                  | `signaling-server/`, `lib/signaling/`, `lib/tauri/transport-rtc.ts`                            | [0021](./docs/content/docs/en/adr/0021-webrtc-datachannel-wan-transport.md)                                                                                                                                                                                                |
| Agent-Team 运行时硬化（BudgetGuard、TeammatePool、ConcurrencyController） | `lib/agent-team/`, `src-tauri/src/agents/`                                                     | [0022](./docs/content/docs/en/adr/0022-agent-team-runtime-hardening.md)                                                                                                                                                                                                    |
| OCR 子系统（17 提供商 + Dexie 结果缓存 + PDF 文本层快速通道）             | `lib/ocr/`, `lib/db/ocr-results.ts`, `src-tauri/src/ocr/`, `plugins/ocr/`                      | [0024](./docs/content/docs/en/adr/0024-ocr-subsystem.md)                                                                                                                                                                                                                   |

> 部分较新 ADR 暂无中文译本，链接指向英文版。

## 技术栈

| 分层            | 主要技术                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端            | Next.js 16（App Router、静态导出）、React 19、TypeScript 5、Tailwind v4（`@tailwindcss/postcss`）、shadcn/ui（`new-york`）、Radix UI、`next-intl`                                                       |
| 状态 / 数据     | Zustand 5、Dexie 4 + `dexie-react-hooks`、`zundo`、React Hook Form、Zod 4                                                                                                                               |
| 编辑器 / 可视化 | React Flow（`@xyflow/react`）、Monaco、CodeMirror、Mermaid、KaTeX、three / r3f、Recharts、`motion`                                                                                                      |
| AI              | `ai`（Vercel AI SDK v6）、`@ai-sdk/{anthropic,openai,google,mistral,cohere}`、`@modelcontextprotocol/sdk`、`@anthropic-ai/claude-agent-sdk`（sidecar）、`@opencode-ai/sdk`、`@huggingface/transformers` |
| 桌面核心        | Tauri 2.11、Rust 1.84.1+、`axum`（伴侣 / MCP HTTP）、`tokio`、`rusqlite` + `sqlite-vec`、`webrtc-rs`、`wasmtime` 26（含 WASI）、`keyring`、`git2`、`qdrant-client`、可选 `ocrs` / `oar-ocr`             |
| 移动外壳        | Capacitor 7（iOS / Android）、`@capacitor-mlkit/barcode-scanning`、生物识别 / 安全存储 / 录音插件                                                                                                       |
| Sidecar         | Node 20+ ESM、Anthropic Claude Agent SDK、AI SDK 提供商、`fast-glob`、`diff`                                                                                                                            |
| 质量            | Jest 30 + RTL、Playwright（E2E / mobile / Tauri）、ESLint 9、Prettier 3、Husky + lint-staged + commitlint（`config-conventional`）                                                                      |
| 文档            | Fumadocs（`docs/`，端口 3001）                                                                                                                                                                          |

## 前置要求

### Web / 桌面应用

- **Node.js** 20.x 或更高
- **pnpm** 10.x（lockfile 仅支持 pnpm；不要在 workspace 根目录使用 npm/yarn）
  ```bash
  npm install -g pnpm
  ```
- **Rust** 1.84.1 或更高（Tauri MSRV，由可选的 `ocr-paddle` 特性抬升）
  ```bash
  rustc --version
  cargo --version
  ```
- 各平台构建依赖：
  - **Windows** —— Visual Studio C++ 生成工具（"使用 C++ 的桌面开发"）
  - **macOS** —— Xcode 命令行工具
  - **Linux** —— 参见 [Tauri 前置要求](https://tauri.app/start/prerequisites/)

### 移动外壳

- **Xcode** 15+（iOS）或 **Android Studio** Hedgehog+（Android）
- macOS 上 iOS 构建需要 CocoaPods（`brew install cocoapods`）
- 必须先执行一次 `pnpm build` —— Capacitor 外壳包裹的是 `../out`

### 可选特性

- **Cloudflared** —— GitHub Delivery webhook 接收器通过 Tauri shell 插件自动派生
- **TURN 凭据** —— 仅自建 WebRTC TURN 时需要（存入 OS keyring，永不明文）
- **CMake + C++ 工具链** —— 仅在构建 `ocr-tesseract` 特性时需要

## 安装

```bash
git clone https://github.com/AstroAir/cognia-next
cd cognia-next

# 安装 workspace（主应用 + docs + mobile + plugin-sdk/typescript）
pnpm install

# 安装 Node sidecar（独立包，不在 workspace）
pnpm sidecar:install

# 构建随包的 VS Code 扩展宿主 sidecar
pnpm sidecars:build

# 复制 Monaco 编辑器资源（predev/prebuild 也会自动执行）
pnpm monaco:copy
```

Husky 通过根 `prepare` 脚本自动安装 `pre-commit`（lint-staged）和 `commit-msg`（commitlint）钩子，无需额外操作。

## 开发

### Web（浏览器，端口 3000）

```bash
pnpm dev
```

打开 <http://localhost:3000>。`predev` 会自动复制 Monaco 资源。

### 桌面（Tauri）

```bash
pnpm tauri dev      # 启动 Next.js 并打开 Tauri 窗口
pnpm tauri info     # 打印 Tauri/Rust 工具链信息
pnpm tauri build    # 生产环境桌面包
```

Tauri 的 `beforeDevCommand` 是 `pnpm dev`，`beforeBuildCommand` 是 `pnpm build`；两种外壳都消费 `out/`。

### 移动（Capacitor）

```bash
pnpm build              # 先产出 out/ —— 必须
pnpm mobile:sync        # 把 out/ 同步到原生 iOS/Android 工程
pnpm mobile:open:ios    # 打开 Xcode
pnpm mobile:open:android # 打开 Android Studio
```

LAN/WAN 连接桌面实例的流程参见 ADR-0014 / ADR-0021 与 `app/(mobile-onboard)/`。

### 文档站（Fumadocs，端口 3001）

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:start
```

文档站是完整的 Next.js 服务端应用，与主应用的静态导出独立部署。

### Sidecars

```bash
pnpm sidecar:start          # 独立运行 Claude Code 宿主 sidecar
pnpm sidecar:smoke          # 烟雾测试
pnpm sidecar:test           # node --test sidecar/builtin-tools + dispatch
pnpm sidecar:vscode:build   # 构建 VS Code 扩展宿主 sidecar
```

### 信令服务器

```bash
pnpm webrtc:smoke           # 烟雾测试 signaling-server WebSocket 协议
```

信令服务器本身是独立的 Node 包 —— 详见 `signaling-server/README.md`。

## 可用脚本

### 前端

| 命令                                                                                     | 描述                                                   |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `pnpm dev`                                                                               | Next.js 开发服务器，端口 3000                          |
| `pnpm build`                                                                             | 生产构建 → `out/`（Tauri 与 Capacitor 共用的静态导出） |
| `pnpm start`                                                                             | Next.js 生产服务器                                     |
| `pnpm lint` / `lint:fix`                                                                 | ESLint 9                                               |
| `pnpm format` / `format:check`                                                           | Prettier 3                                             |
| `pnpm typecheck`                                                                         | TypeScript 类型检查（不生成产物）                      |
| `pnpm test` / `test:watch` / `test:coverage`                                             | Jest 30 + React Testing Library                        |
| `pnpm test:e2e`                                                                          | Playwright（全部项目）                                 |
| `pnpm test:e2e:workflows` / `:workflows:nodes` / `:workflows:editor` / `:workflows:runs` | 工作流编辑器 / 运行时套件                              |
| `pnpm test:e2e:mobile` / `:mobile:ios`                                                   | 移动视口 / iOS WebKit                                  |
| `pnpm test:e2e:tauri`                                                                    | 驱动真实 Tauri debug 包                                |
| `pnpm test:e2e:install` / `:report`                                                      | 安装 Chromium+WebKit / 打开 HTML 报告                  |
| `pnpm monaco:copy`                                                                       | 复制 Monaco worker 资源到 `public/`                    |

### 仓库闸口

| 命令                                               | 描述                                          |
| -------------------------------------------------- | --------------------------------------------- |
| `pnpm audit:slots`                                 | 校验插件 slot 清单                            |
| `pnpm audit:silent-flags`                          | 检测静默失败代码路径                          |
| `pnpm lint:i18n`                                   | 把 `i18n/messages/{en,zh-CN}.json` 与基线对比 |
| `pnpm lint:i18n:baseline`                          | 在故意变更键之后重写 i18n 基线                |
| `pnpm sync:plugin-sdk-wit` / `lint:plugin-sdk-wit` | 保持插件 SDK 的 WIT 绑定同步                  |

### Tauri / 移动 / 文档

| 命令                                                           | 描述                  |
| -------------------------------------------------------------- | --------------------- |
| `pnpm tauri dev` / `build` / `info`                            | Tauri 桌面            |
| `pnpm mobile:sync` / `mobile:open:ios` / `mobile:open:android` | Capacitor 移动端      |
| `pnpm docs:dev` / `docs:build` / `docs:start`                  | Fumadocs（端口 3001） |

### Sidecars / WebRTC

| 命令                                                          | 描述                              |
| ------------------------------------------------------------- | --------------------------------- |
| `pnpm sidecar:install` / `sidecar:start` / `sidecar:smoke`    | Claude Code 宿主 sidecar          |
| `pnpm sidecar:test`（`:builtin` + `:dispatch`）               | `node --test` 套件                |
| `pnpm sidecar:vscode:install` / `:build` / `:test` / `:clean` | VS Code 扩展宿主 sidecar          |
| `pnpm sidecars:install` / `sidecars:build` / `sidecars:test`  | 全部 sidecar                      |
| `pnpm webrtc:smoke`                                           | 烟雾测试 signaling-server WS 协议 |

### 添加 shadcn/ui 组件

```bash
pnpm dlx shadcn@latest add card
pnpm dlx shadcn@latest add button card dialog
```

## 项目结构

```
cognia-next/
├── app/                      # Next.js App Router
│   ├── (mobile-onboard)/    # 移动端引导路由组
│   ├── a2ui/  agent-teams/  canvas/  discover/
│   ├── github-delivery/  inbox/  logs/  me/
│   ├── plugins/  scheduler/  settings/  share-target/
│   ├── skills/  twin/  workflows/
│   └── layout.tsx           # 根布局（TooltipProvider、next-intl provider）
├── components/
│   ├── ui/                  # 57 个预装 shadcn/ui 原语（无测试）
│   ├── ai-elements/         # 内嵌 AI Elements（无测试）
│   ├── automation/  chat/  connectors/  goal/  inbox/
│   ├── plugins/  settings/  twin/  workflow/  workflows/
│   └── …                    # 其他一等公民组件均附带 *.test.tsx
├── hooks/                    # 可复用 React Hooks
├── lib/                      # 全部业务逻辑
│   ├── a2ui/  agent-team/  ai-sdk/  automation/
│   ├── claude/  connectors/  data/  db/  external-bridge/
│   ├── github/  goal/  mobile/  ocr/  plugin/  scheduler/
│   ├── signaling/  skills/  slash-commands/  subscription/
│   ├── tauri/  twin/  vector/  wiki/  workflow/  …
│   ├── browser-stubs/       # 服务端独有依赖的空 stub
│   └── utils.ts             # cn() = clsx + tailwind-merge
├── plugins/                  # 内置一等公民插件
│   ├── anthropic-skills/  clipboard-history/  clipboard-tools/
│   ├── computer-use/  e2b-sandbox/  github-delivery/  ocr/
│   ├── playwright-mcp/  prompt-templates/  screenshot/
│   ├── stagehand-mcp/  test-lsp-contribution/
│   ├── wasm-example-formatter/  web-tools/  workflow-ai/
│   └── workspace-tools/
├── plugin-sdk/typescript/    # 发布的插件 SDK（workspace 子包）
├── i18n/                     # next-intl
│   ├── request.ts  config.ts
│   └── messages/en.json  messages/zh-CN.json
├── src-tauri/                # Tauri 2.11 Rust 核心
│   ├── src/
│   │   ├── automation/  canvas/  ccswitch/  claude/
│   │   ├── companion_api/  connectors/  external_agent/
│   │   ├── hooks/  logging/  mcp_server/  plugin_api/
│   │   ├── proxy_config/  remote_control/  scheduler/
│   │   ├── skills/  subscription/  tts/  vector/
│   │   ├── wallpaper/  workflow/  a2ui_bridge/
│   │   ├── bin/cognia-server.rs   # Headless V2 服务器二进制
│   │   ├── main.rs  lib.rs  commands.rs  menu.rs
│   │   └── …
│   ├── icons/  capabilities/  resources/
│   ├── tauri.conf.json
│   └── Cargo.toml
├── sidecar/                  # Node sidecar（不在 pnpm workspace 中）
│   ├── claude-host.mjs       # Claude Agent SDK 宿主
│   ├── a2ui-mcp.mjs          # A2UI 桥 MCP 服务器
│   ├── dispatch/  builtin-tools/  fetch-interceptor.mjs
│   ├── vscode-ext-host/      # VS Code 扩展宿主 sidecar
│   └── package.json          # 独立 lockfile，独立安装
├── mobile/                   # Capacitor 7 外壳（workspace 子包）
├── docs/                     # Fumadocs 站（workspace 子包，端口 3001）
│   └── content/docs/{en,zh}/adr/   # 架构决策记录
├── signaling-server/         # 独立的 WebRTC 信令汇合服务
├── tests/e2e/                # Playwright 套件（workflows / mobile / tauri）
├── scripts/                  # 构建/审计辅助（copy-monaco、audit-slots、
│                             #   lint-i18n、build-vscode-ext-host-sidecar 等）
├── components.json           # shadcn/ui 配置
├── next.config.ts            # withNextIntl + 静态导出 + Node 内置 stub
├── pnpm-workspace.yaml       # docs、mobile、plugin-sdk/typescript
└── package.json
```

## 配置

### 环境变量

```bash
cp .env.example .env.local
```

- 以 `NEXT_PUBLIC_` 开头的变量会暴露给浏览器
- 切勿提交 `.env.local`
- `lib/env.ts` 在首次访问时校验必需变量

### Tauri 配置

`src-tauri/tauri.conf.json` 已为 Cognia 配好合理默认值：

- `productName: "Cognia"`，identifier `com.reactquickstarter.desktop`
- Deep link 协议：`cognia://`
- 自定义标题栏（`decorations: false`，macOS 上覆盖式红绿灯）
- 强制 CSP 锁定到 `'self'` + `ipc:`，禁止远程脚本/样式源
- 打包 sidecar 资源：`claude-host.mjs`、`a2ui-mcp.mjs`、VS Code 扩展宿主构建产物及其 `node_modules`
- CLI 参数：可选 `workspace` 路径 + `--new-chat` / `-n` 标志

### 路径别名

```ts
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
```

- `@/components` → `components/`
- `@/lib` → `lib/`
- `@/ui` → `components/ui/`
- `@/hooks` → `hooks/`
- `@/utils` → `lib/utils.ts`

### Tailwind v4

- `@tailwindcss/postcss` + `app/globals.css` 中的 CSS 变量
- 类策略暗色模式（`@custom-variant dark (&:is(.dark *))`）
- oklch 颜色令牌

## 工作规则（动代码前先读）

完整规则见 `CLAUDE.md`。重点：

1. **先研究，再实现。** 写新工具/组件/Hook 前，先在 `lib/`、`components/`、`hooks/`、`src-tauri/` 和 ADR 中搜索已有实现。
2. **不允许简化。** 完整实现需求 —— 不许 stub、mock 或 `// TODO later` 形式的生产代码。遇到阻塞要明确暴露，而非默默缩减范围。
3. **每个组件都附带单元测试。** `components/**`、`hooks/**`、`lib/**` 或 `src-tauri/src/**` 下的新文件必须有同位的 `*.test.ts(x)` 或 in-file `#[cfg(test)]` 测试。覆盖率必须 ≥90%（行/分支/函数）。`components/ui/`（shadcn）和 `components/ai-elements/`（内嵌）除外。
4. **i18n 是硬性要求。** `.tsx` 里禁止硬编码用户可见字符串。使用 `next-intl` 的 `useTranslations()` / `getTranslations()`，并把新键同时加到 `i18n/messages/en.json` 和 `i18n/messages/zh-CN.json`，运行 `pnpm lint:i18n` 验证两边一致。Aria label、placeholder、toast、错误消息都算用户可见。
5. **复用横切 Hook，不要重造轮子。** PII 脱敏（`lib/twin/ingest/redact.ts`）、静默时段（`lib/connectors/outbound-runner`）、构建选项管道（`lib/claude/build-options.ts:resolveSendOptions`）、A2UI ⇄ IM 桥（`lib/connectors/a2ui-bridge/`）都是共享入口 —— 修改它们，而不是新开分叉。

## 测试

- **同位放置** —— `xxx.test.ts(x)` 与源码同目录。不使用 `__tests__/` 或 `tests/` 单元测试目录。
- **覆盖率闸口** —— ≥90% 行/分支/函数；用 `pnpm test:coverage` 验证。
- **Rust** —— in-file `#[cfg(test)] mod tests { ... }`；集成测试放 `src-tauri/tests/`。
- **Sidecar** —— `pnpm sidecar:test` 使用 Node 内置 `node --test`（不是 Jest）。
- **E2E** —— Playwright 配置专门的 `mobile-pixel-7`、`mobile-iphone-13`、`tauri` 项目。Tauri 项目跑真实的 debug 包（`pretest:e2e:tauri` 先构建）。

## 提交钩子

Husky 通过根 `prepare` 脚本接管 —— `pnpm install` 一次就生效。

- `pre-commit` → `lint-staged`（对暂存文件执行 `eslint --fix` + `prettier --write`）
- `commit-msg` → `commitlint` + `@commitlint/config-conventional`

**绝不用 `--no-verify` 绕过。** 钩子失败时，修根因，重新暂存，创建 **新提交** —— 失败那次提交从未真正生成，`--amend` 会改到上一次错的提交上。

## 生产构建

### Web / 静态导出

```bash
pnpm build
# → out/  （由 Tauri 的 frontendDist 和 Capacitor 的 webDir 同时消费）
```

### 桌面

```bash
pnpm tauri build
# 产物（workspace 根目录 target/）：
# - Windows: target/release/bundle/msi/  (及 nsis/)
# - macOS:   target/release/bundle/dmg/  (及 app/)
# - Linux:   target/release/bundle/{appimage,deb,rpm}/
```

可选 OCR 特性通过 Cargo feature 标志控制 —— 见 `src-tauri/Cargo.toml` 中的 `ocr-tesseract`、`ocr-windows`、`ocr-apple`、`ocr-ocrs`、`ocr-paddle`。默认构建提供占位后端，保证派发表在任何平台都能编译。

### 移动

```bash
pnpm mobile:sync
pnpm mobile:open:ios       # 在 Xcode 中构建 / 签名 / 归档
pnpm mobile:open:android   # 在 Android Studio 中构建 / 签名 / 打包
```

### 文档

```bash
pnpm docs:build
# 产物：docs/.next/  —— 部署到任意 Node.js 主机。Vercel 上把根目录设为 docs/。
```

## 部署

- **桌面** —— 分发 `target/release/bundle/`（workspace 根目录）下的 `.msi` / `.dmg` / `.AppImage`。代码签名按项目约定处理。
- **移动** —— 在 `pnpm mobile:sync` 之后通过 App Store Connect / Google Play 提交。
- **文档** —— `docs/` 是完整的 Next.js 服务端应用（**不是** 静态导出）；可部署到 Vercel / Railway / Fly.io / 自托管 Node。
- **信令服务器** —— 把 `signaling-server/` 部署到任何支持 WebSocket 的 Node 主机。TURN 凭据放进桌面端 OS keyring，绝不内嵌代码。

## 故障排除

**端口 3000 已被占用**

```powershell
# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 3000 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }
```

```bash
# macOS / Linux
lsof -ti:3000 | xargs kill -9
```

**Tauri 构建失败**

```bash
pnpm tauri info
rustup update
cd src-tauri && cargo clean
```

**模块未找到**

```bash
rm -rf .next
rm -rf node_modules docs/node_modules mobile/node_modules pnpm-lock.yaml
pnpm install
pnpm sidecar:install
```

**文档中出现 `Cannot find module 'collections/server'`**

```bash
pnpm docs:dev    # 首次运行会生成 docs/.source/
```

**i18n 校验不通过**

```bash
pnpm lint:i18n             # 与基线 diff
pnpm lint:i18n:baseline    # 仅在你确实增删了键之后再跑
```

**Monaco 资源缺失**

```bash
pnpm monaco:copy           # predev/prebuild 会自动跑
```

## 关键说明

- **仅支持 pnpm** —— 在仓库根目录安装。lockfile 为 pnpm 格式。
- **不要删 `next.config.ts` 中的 `output: "export"`** —— Tauri 和 Capacitor 都消费 `out/`。`docs/next.config.ts` 是完整服务端应用；两者必须保持分开。
- **静态导出注意事项** —— `app/api/` 在运行时不存在。任何需要 HTTP 服务器的能力（MCP HTTP、webhook 接收、cron 守护、headless V2 API）都活在 Tauri Rust（axum）里，而非 Next.js 路由里。
- **服务端独有依赖** —— 向量数据库 SDK 和 `simple-git` 在 `next.config.ts` 中被别名到 `lib/browser-stubs/empty.js`。新增服务端独有依赖时要 **同时** 加到 `SERVER_ONLY_PACKAGES` 和 `serverExternalPackages`；真正 Node 独有的内置模块加到 `NODE_ONLY_MODULES`。配置错了会炸掉移动端 bundle。
- **原生向量存储** —— sqlite-vec 位于 `<app_data>/cognia/vectors.sqlite`。Web 模式会隐藏原生选项并强制使用云后端。
- **Rust 工具链** —— 1.84.1+（Tauri MSRV 是 1.77.2；可选 `ocr-paddle` 特性会抬升）。
- **Conventional Commits** 由 `commit-msg` 钩子强制。

## 了解更多

- **ADR** —— `docs/content/docs/zh/adr/`（运行 `pnpm docs:dev` 后访问 <http://localhost:3001>）
- **插件 SDK** —— `plugin-sdk/typescript/` + `docs/content/docs/zh/plugin-dev/`
- **CLAUDE.md** —— 面向 AI 协作贡献者的完整开发规则 + 子系统地图
- **Tauri** —— [Tauri 2 文档](https://tauri.app/)
- **Next.js 16** —— [Next.js 文档](https://nextjs.org/docs)
- **Fumadocs** —— [Fumadocs 文档](https://fumadocs.dev/)
- **shadcn/ui** —— [shadcn/ui 文档](https://ui.shadcn.com/)（`new-york` 风格，RSC 模式）
- **Capacitor 7** —— [Capacitor 文档](https://capacitorjs.com/docs)

## 贡献

1. Fork 仓库
2. 创建功能分支（`git checkout -b feat/your-feature`）—— 遵循 `<type>/<short-kebab>` 命名
3. 做聚焦、外科手术式的改动（参见上文工作规则）
4. 同步增/改同位测试
5. 运行 `pnpm lint`、`pnpm typecheck`、`pnpm test` 以及相关的 `pnpm test:e2e:*`
6. 用 Conventional Commits 提交（钩子会拒收不符合规范的消息）
7. 开 PR —— 关联相关 ADR

## 许可证

AGPL-3.0-or-later —— 见 [LICENSE](./LICENSE)。

## 支持

- 阅读 `docs/content/docs/zh/adr/` 下对应的 ADR
- 查看[故障排除](#故障排除)章节
- 在 GitHub 上提 issue：<https://github.com/AstroAir/cognia-next/issues>
