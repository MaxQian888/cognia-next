<h1 align="center">Cognia</h1>

<p align="center">
  面向 Claude Code 的 AI 桌面客户端 —— 内置插件运行时、可视化工作流、员工数字分身、
  IM 连接器、Computer Use 自动化、OCR 与广域网级移动伴侣。
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-10.30-F69220?logo=pnpm&logoColor=white">
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-black?logo=next.js">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2.11-FFC131?logo=tauri&logoColor=black">
  <img alt="Capacitor" src="https://img.shields.io/badge/Capacitor-8-119EFF?logo=capacitor&logoColor=white">
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./docs/content/docs/zh/adr/">架构决策记录</a> ·
  <a href="./CLAUDE.md">工作规则</a>
</p>

---

> [!WARNING]
> **当前项目正在经历重大重构。** API、数据结构与各项功能随时可能变更或损坏，现阶段**不保障可用性**。
> 如有依赖，请固定到一个已知可用的提交。

## 总览

Cognia 用同一份 Next.js 16 静态导出驱动三种外壳 —— 浏览器、Tauri 2 桌面与 Capacitor 8 移动端 ——
共享同一套 UI、同一份 i18n 词条、同一套业务逻辑。Rust 核心承载常驻服务（HTTP、调度器、向量存储、
自动化、OCR、MCP 服务器），随包的 Node sidecar 托管 Claude Agent SDK。

## 特性

- **Claude Code 桌面化** —— 聊天界面、斜杠命令、Agents、Skills、MCP、Hooks 全套就位。
- **插件运行时** —— 20+ 一等公民插件（Computer Use、OCR、GitHub Delivery、剪贴板、截图、
  Stagehand/Playwright MCP、e2b 沙盒、Prompt 模板、知乎流水线 …）背靠 WASM 宿主
  （`wasmtime` + WIT 绑定）。
- **可视化工作流** —— React Flow 编辑器配 TS/Rust 混合运行时；支持 cron、webhook、连接器、聊天与
  `/goal` 完成等触发器。
- **员工数字分身** —— 分阶段摄取、多 Agent 蒸馏、运行时 RAG + 风格 few-shot，统一经过共享的
  PII 脱敏器。
- **IM 连接器** —— Telegram、Discord、Slack、Lark、OneBot、企业微信与个人微信统一接入
  `ConnectorBus`，自带静默时段、熔断、以及按平台降级富内容的 A2UI ⇄ IM 桥。
- **Computer Use** —— 把 Anthropic 原生工具调用分派到各 OS 自动化后端（Windows UIA、macOS AX、
  Linux AT-SPI），配套三级权限模型与 HITL 确认遮罩。
- **OCR** —— 17 个提供商（云文档、LLM 视觉、专用、Lark、5 个本地后端）汇聚到一个
  `extract()` API，带 Dexie 结果缓存。
- **移动 + 广域网** —— Capacitor 客户端通过 LAN/HTTPS 加 mDNS 发现 + JWT 配对接入，可选启用
  WebRTC 层，搭配独立信令服务器。
- **零知识公共分享链** —— Cloudflare Worker + R2/KV，密钥放在 URL fragment，仅在查看器中解密。

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│  Next.js 16（App Router，静态导出 → out/）                    │
│  app/  components/  hooks/  lib/  plugins/  i18n/            │
└──────────────────────────────────────────────────────────────┘
        │                   │                   │
        ▼                   ▼                   ▼
   浏览器 dev           Tauri 2 桌面         Capacitor 8 移动端
   (pnpm dev)          (src-tauri/, Rust    (mobile/, 包裹
                        核心 + axum HTTP     ../out, headless
                        + 调度器 + agents    服务器的 LAN /
                        + 自动化 + OCR)      WAN 客户端)
                            │
                            ▼
                    Node sidecar (sidecar/)
                    Claude Agent SDK + A2UI MCP
```

monorepo 旁有两个独立服务：

- `signaling-server/` —— WebRTC 信令汇合（axum + workers-rs）。
- `share-server/` —— Cloudflare Worker + Vite 查看器，承载公共分享链。

完整子系统目录与一对一的 ADR 见
[`docs/content/docs/zh/adr/`](./docs/content/docs/zh/adr/)。

## 快速开始

```bash
git clone https://github.com/MaxQian888/cognia-next
cd cognia-next
pnpm install                   # workspace（主应用 + docs + mobile + plugin-sdk）
pnpm sidecar:install           # Node sidecar（独立 lockfile）
pnpm dev                       # 浏览器开发服务器 → http://localhost:3000
```

桌面与移动外壳：

```bash
pnpm tauri dev                 # 桌面窗口
pnpm build && pnpm mobile:sync # 移动端（再用 mobile:open:ios / :android 打开）
```

> Husky 钩子由根 `prepare` 脚本自动接管，无需额外配置。

## 前置要求

| 目标   | 要求                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------- |
| Web    | Node.js ≥ 20、pnpm 10                                                                             |
| 桌面   | Rust ≥ 1.84.1（Tauri 2）+ 平台 C/C++ 工具链（[前置要求](https://tauri.app/start/prerequisites/)） |
| 移动端 | Xcode 15+（iOS）或 Android Studio Hedgehog+（Android）；iOS 需要 CocoaPods                        |

可选：`cloudflared`（GitHub Delivery webhook 自动派生）、自托管 WebRTC 时的 TURN 凭据、
构建 `ocr-tesseract` Cargo 特性时的 CMake/C++ 工具链。

## 项目结构

```
cognia-next/
├── app/                   Next.js App Router（静态导出）
├── components/            React 组件（ui/ = shadcn，ai-elements/ = 内嵌）
├── hooks/  lib/  types/   业务逻辑、Hook、共享类型
├── plugins/               内置一等公民插件
├── plugin-sdk/typescript/ 发布的插件 SDK（workspace 子包）
├── i18n/                  next-intl request + messages（en、zh-CN）
├── src-tauri/             Tauri 2 Rust 核心（axum HTTP、调度器、自动化、OCR、…）
├── sidecar/               Node sidecar（Claude Agent SDK 宿主、A2UI MCP）—— 独立 lockfile
├── mobile/                Capacitor 8 外壳（workspace 子包）
├── docs/                  Fumadocs 站点 + ADR（workspace 子包，端口 3001）
├── signaling-server/      独立的 WebRTC 信令汇合服务
├── share-server/          Cloudflare Worker + Vite 查看器，承载分享链
├── tests/e2e/             Playwright 套件（workflows、mobile、tauri）
└── scripts/               构建、审计、迁移辅助
```

## 脚本

```bash
# 应用
pnpm dev | build | start | lint | format | typecheck
pnpm test | test:watch | test:coverage

# 桌面
pnpm tauri dev | build | info

# 移动端（先跑 pnpm build —— Capacitor 包裹 out/）
pnpm mobile:sync
pnpm mobile:open:ios | mobile:open:android

# 文档站（Fumadocs，端口 3001）
pnpm docs:dev | docs:build | docs:start

# Sidecars
pnpm sidecar:install | sidecar:start | sidecar:smoke | sidecar:test
pnpm sidecars:build                       # 全部 sidecar

# E2E（Playwright）
pnpm test:e2e                             # 全部 project
pnpm test:e2e:workflows | :mobile | :tauri
pnpm test:e2e:install | :report

# 仓库闸口
pnpm audit:slots                          # 插件 slot 清单
pnpm audit:silent-flags                   # 静默失败代码路径
pnpm lint:i18n | lint:i18n:baseline       # next-intl 键平衡
pnpm lint:plugin-sdk-wit                  # 插件 SDK WIT 绑定

# 其他
pnpm webrtc:smoke                         # signaling-server 协议烟雾测试
pnpm dlx shadcn@latest add <component>
```

## 配置

- **环境变量** —— `cp .env.example .env.local`。`NEXT_PUBLIC_*` 变量会暴露给浏览器；
  `lib/env.ts` 在首次访问时校验必需值。`.env.local` 切勿提交。
- **Tauri** —— `src-tauri/tauri.conf.json` 定义产品名（`Cognia`）、identifier
  （`com.reactquickstarter.desktop`）、Deep link 协议（`cognia://`）、强制 `'self'` CSP、
  自定义标题栏，以及随包的 sidecar 资源。
- **路径别名** —— `@/components`、`@/lib`、`@/ui`、`@/hooks`、`@/utils`。
- **样式** —— Tailwind v4 + `@tailwindcss/postcss`、oklch CSS 变量、类策略暗色模式
  （`@custom-variant dark (&:is(.dark *))`）。

## 约定

这是项目级硬性规则 —— 完整版见 [`CLAUDE.md`](./CLAUDE.md)。

1. **先研究，再实现。** 写新工具/Hook/组件前，先在 `lib/`、`components/`、`hooks/`、
   `src-tauri/` 与对应 ADR 中搜索已有实现，优先复用。
2. **不允许悄悄简化。** 完整实现需求，或明确暴露阻塞 —— 不许 stub、mock 或 `// TODO later`
   形式的生产路径。
3. **测试不可选。** `components/**`、`hooks/**`、`lib/**`、`src-tauri/src/**` 下的新文件
   （除 `components/ui/` 与 `components/ai-elements/` 外）必须附带同位测试。
   覆盖率维持在 ≥ 90 % 行 / 分支 / 函数。
4. **i18n 是硬性要求。** `.tsx` 中禁止硬编码用户可见字符串。同步把键加到
   `i18n/messages/en.json` 与 `i18n/messages/zh-CN.json`，再跑 `pnpm lint:i18n`。
5. **复用共享 Hook。** PII 脱敏（`lib/twin/ingest/redact.ts`）、静默时段
   （`lib/connectors/outbound-runner`）、构建选项管道（`lib/claude/build-options.ts`）以及
   A2UI ⇄ IM 桥（`lib/connectors/a2ui-bridge/`）都是共享入口 —— 修改它们，而不是开分叉。

## 测试

- **同位放置** —— `*.test.ts(x)` 与源码并排；单元测试不使用 `__tests__/` 或 `tests/` 目录。
- **覆盖率** —— `pnpm test:coverage`（Jest 30 + RTL）。
- **Rust** —— in-file `#[cfg(test)] mod tests { … }`；集成测试放 `src-tauri/tests/`。
- **Sidecar** —— `pnpm sidecar:test`（Node 内置 `node --test`，不是 Jest）。
- **E2E** —— Playwright 配置专门的 `mobile-pixel-7`、`mobile-iphone-13`、`tauri` 项目。
  Tauri 项目跑真实 debug 包（`pretest:e2e:tauri` 先构建）。

## 提交钩子

- `pre-commit` → `lint-staged`（对暂存文件执行 `eslint --fix` + `prettier --write`）。
- `commit-msg` → `commitlint`（`@commitlint/config-conventional`）—— 强制 Conventional Commits。

**绝不要用 `--no-verify` 绕过。** 钩子失败时，修根因，重新暂存，创建**新提交** ——
失败那次提交从未真正生成，`--amend` 会改到上一次错的提交上。

## 构建

```bash
# Web / 静态导出 → out/  （由 Tauri 和 Capacitor 同时消费）
pnpm build

# 桌面 → target/release/bundle/{msi,nsis,dmg,app,appimage,deb,rpm}/
pnpm tauri build

# 移动端 —— 先同步，再到 Xcode / Android Studio 签名归档
pnpm mobile:sync
pnpm mobile:open:ios | mobile:open:android

# 文档站（Next.js 服务端应用）→ docs/.next/
pnpm docs:build
```

可选 OCR 后端由 Cargo feature 控制 —— 见 `src-tauri/Cargo.toml` 中的 `ocr-tesseract`、
`ocr-windows`、`ocr-apple`、`ocr-ocrs`、`ocr-paddle`。默认构建保留占位后端，保证派发表在任何
平台都能编译。

## 技术栈

| 分层            | 主要技术                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 前端            | Next.js 16、React 19、TypeScript、Tailwind v4、shadcn/ui（`new-york`）、Radix UI、`next-intl`                                      |
| 状态 / 数据     | Zustand 5、Dexie 4 + `dexie-react-hooks`、`zundo`、React Hook Form、Zod 4                                                          |
| 编辑器 / 可视化 | React Flow、Monaco、CodeMirror、Mermaid、KaTeX、three / r3f、Recharts、`motion`                                                    |
| AI              | Vercel AI SDK v6、`@ai-sdk/*` 提供商、`@modelcontextprotocol/sdk`、`@anthropic-ai/claude-agent-sdk`（sidecar）、`@opencode-ai/sdk` |
| 桌面核心        | Tauri 2.11、Rust 1.84.1+、`axum`、`tokio`、`rusqlite` + `sqlite-vec`、`webrtc-rs`、`wasmtime` 26、`keyring`、`git2`                |
| 移动端          | Capacitor 8（iOS / Android）、条码扫描、生物识别 / 安全存储 / 录音插件                                                             |
| Sidecar         | Node 20+ ESM、Claude Agent SDK、AI SDK 提供商                                                                                      |
| 质量            | Jest 30 + RTL、Playwright、ESLint 9、Prettier 3、Husky + lint-staged + commitlint                                                  |

## 关键说明

- **仅支持 pnpm** —— 在仓库根目录安装。lockfile 为 pnpm 格式。
- **不要删 `next.config.ts` 中的 `output: "export"`** —— Tauri 和 Capacitor 都消费 `out/`。
  `docs/next.config.ts` 是完整服务端应用；两者必须保持分开。
- **运行时不存在 `app/api/`。** 任何需要 HTTP 服务器的能力（MCP HTTP、webhook 接收、
  headless V2 API）都活在 Tauri Rust（axum）里，而非 Next.js 路由。
- **服务端独有依赖** —— 向量数据库 SDK 与 `simple-git` 被别名到
  `lib/browser-stubs/empty.js`。新增服务端独有依赖时要**同时**加到
  `SERVER_ONLY_PACKAGES` 和 `serverExternalPackages`；真正 Node 独有的内置模块加到
  `NODE_ONLY_MODULES`。

## 故障排除

| 现象                                             | 处理                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 端口 3000 已占用                                 | Windows：`Get-NetTCPConnection -LocalPort 3000 \| % { Stop-Process -Id $_.OwningProcess -Force }` · macOS/Linux：`lsof -ti:3000 \| xargs kill -9` |
| Tauri 构建失败                                   | `pnpm tauri info && rustup update && (cd src-tauri && cargo clean)`                                                                               |
| 模块未找到                                       | `rm -rf node_modules docs/node_modules mobile/node_modules pnpm-lock.yaml && pnpm install`                                                        |
| 文档中 `Cannot find module 'collections/server'` | `pnpm docs:dev` 跑一次生成 `docs/.source/`                                                                                                        |
| i18n 校验不通过                                  | `pnpm lint:i18n` 对比基线 · `pnpm lint:i18n:baseline` 仅在确实改键之后跑                                                                          |
| Monaco 资源缺失                                  | `pnpm monaco:copy`（`predev` / `prebuild` 也会自动跑）                                                                                            |

## 贡献

1. Fork 仓库并创建功能分支 —— `<type>/<short-kebab>`（如 `feat/connector-wecom`）。
2. 做聚焦、外科手术式的改动 —— 参见[约定](#约定)。
3. 同步增/改同位测试。
4. 运行 `pnpm lint`、`pnpm typecheck`、`pnpm test` 与相关的 `pnpm test:e2e:*`。
5. 用 Conventional Commits 提交，开 PR 时关联相关 ADR。

## 了解更多

- **ADR** —— [`docs/content/docs/zh/adr/`](./docs/content/docs/zh/adr/)（运行 `pnpm docs:dev`
  后访问 <http://localhost:3001>）
- **插件 SDK** —— [`plugin-sdk/typescript/`](./plugin-sdk/typescript/)
- **工作规则** —— [`CLAUDE.md`](./CLAUDE.md)
- **外部文档** —— [Tauri 2](https://tauri.app/) · [Next.js 16](https://nextjs.org/docs) ·
  [shadcn/ui](https://ui.shadcn.com/) · [Capacitor](https://capacitorjs.com/docs) ·
  [Fumadocs](https://fumadocs.dev/)

## 许可证

[AGPL-3.0-or-later](./LICENSE)。

## 支持

- 阅读 [`docs/content/docs/zh/adr/`](./docs/content/docs/zh/adr/) 下对应 ADR。
- 提交 issue：<https://github.com/MaxQian888/cognia-next/issues>。
