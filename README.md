# Cognia

Cognia is an AI desktop client for Claude Code — and a runtime for plugins, visual workflows, employee digital twins, platform connectors, computer-use automation, OCR, and WAN-grade mobile companion access. The same Next.js 16 static export powers three shells: a browser dev server, a Tauri 2.9 desktop app, and a Capacitor 7 mobile shell, all backed by a Rust core and a Node sidecar.

[中文文档](./README_zh.md) · [Architecture Decision Records](./docs/content/docs/en/adr/) · `productName`: **Cognia** · `identifier`: `com.reactquickstarter.desktop`

## Highlights

- **Plugin platform** — first-party in-tree plugins for computer-use, GitHub delivery, OCR, clipboard, screenshot, web tools, prompt templates, Anthropic skills, Stagehand, Playwright MCP, e2b sandbox, and more. WASM plugin runtime built on `wasmtime` 26 + WIT bindings.
- **Visual workflow editor** — React Flow editor with 38 node kinds and 32 executors; hybrid TypeScript + Rust runtime; cron / webhook / connector / chat triggers; team-aware concurrency scheduler and budget guard.
- **Employee Digital Twin** — 7-stage ingest → 5-agent distillation → runtime RAG + style few-shot, all behind a PII redaction gate.
- **Platform connectors** — Telegram / Discord / Slack / Lark / OneBot with a shared ConnectorBus, outbound runner (quiet-hours, circuit breaker, idempotency), and an A2UI ⇄ IM bridge that auto-downgrades rich content per platform.
- **Computer Use** — Anthropic native tool calls dispatched to per-platform automation (Windows UIA, macOS AX, Linux AT-SPI) with a 3-tier permission model and an HITL consent overlay.
- **OCR subsystem** — 17 providers (4 cloud-doc, 3 LLM-vision, 4 specialist, Lark, 5 local — Tesseract, Windows.Media.Ocr, Apple Vision, ocrs, PaddleOCR PP-OCRv5) behind one `extract()` API with a Dexie-backed result cache.
- **Unified subscription module** — one provider trait, three providers (Claude PKCE / Codex device-code / OpenCode paste-Zen-key) with multi-account vaults and encrypted import/export.
- **WAN mobile transport** — Capacitor mobile client over LAN/HTTPS, mDNS discovery, JWT pairing, and an optional WebRTC data-channel tier with a standalone signaling server and TURN BYO.
- **GitHub delivery** — PR review, Issue→PR, and Release flows modeled as policy-gated workflows with full audit logs.
- **/goal command** — self-driving chat loop with 7 exit conditions, PII-redacted judge, and `generationId` guard.

## Architecture at a glance

```
┌────────────────────────────────────────────────────────────────────┐
│  Next.js 16 (static export → out/) ◄── shared by all 3 shells       │
│  app/  components/  hooks/  lib/  plugins/  i18n/                  │
└────────────────────────────────────────────────────────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
   Browser dev          Tauri 2.9 desktop          Capacitor 7
   (pnpm dev)           (src-tauri/, Rust          (mobile/, wraps
                         core + axum HTTP +         ../out, LAN /
                         scheduler + connectors     tunnel client of
                         + automation + OCR +       the headless server)
                         vector DB)
                              │
                              ▼
                      Node sidecar (sidecar/)
                      • claude-host.mjs (Claude Code SDK host)
                      • a2ui-mcp.mjs   (A2UI bridge MCP server)
                      • dispatch/, builtin-tools/
                      • bundled with the desktop app
```

A separate `signaling-server/` package provides the standalone WebRTC rendezvous service used by the optional WAN transport.

## Subsystem map

Every row has a full ADR under `docs/content/docs/en/adr/` — read the ADR before non-trivial work.

| Subsystem                                                                        | Lives in                                                                                       | ADR                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data backup / transfer (`BackupPackageV3`, AES-GCM envelopes, scheduled backups) | `lib/data/`, `components/settings/data/`, `lib/db/backup-history.ts`                           | [0001](./docs/content/docs/en/adr/0001-backup-schema-v3.md)                                                                                                                                                                                                                |
| Scheduler full-agent resolution                                                  | `src-tauri/src/scheduler/`, `lib/scheduler/`                                                   | [0002](./docs/content/docs/en/adr/0002-scheduler-full-agent-resolution.md)                                                                                                                                                                                                 |
| Employee Digital Twin (ingest → distill → runtime RAG, PII redaction)            | `lib/twin/`, `types/twin/`, `components/twin/`, `app/twin/`                                    | [0003](./docs/content/docs/en/adr/0003-employee-digital-twin.md)                                                                                                                                                                                                           |
| Native vector backend (sqlite-vec) + cloud backends in Rust                      | `src-tauri/src/vector/`, `lib/vector/`                                                         | [0004](./docs/content/docs/en/adr/0004-vector-native-backend.md), [0023](./docs/content/docs/en/adr/0023-vector-cloud-backends-in-rust.md)                                                                                                                                 |
| Remote control & companion API                                                   | `src-tauri/src/remote_control/`, `src-tauri/src/companion_api/`                                | [0005](./docs/content/docs/en/adr/0005-remote-control.md)                                                                                                                                                                                                                  |
| Plugin system (manifest, slots, dexie tables, WASM runtime)                      | `plugins/`, `lib/plugin/`, `src-tauri/src/plugin_api/`                                         | [0006](./docs/content/docs/en/adr/0006-plugin-system.md), [0013 (WASM)](./docs/content/docs/en/adr/0013-wasm-plugins.md), [0016](./docs/content/docs/en/adr/0016-plugin-system-completion.md), [0017](./docs/content/docs/en/adr/0017-workflow-plugin-extension-points.md) |
| External Bridge (wiki indexer + MCP server: 4 tools, 3 resource families)        | `lib/external-bridge/`, `lib/wiki/`, `src-tauri/src/mcp_server/`                               | [0008](./docs/content/docs/en/adr/0008-external-bridge.md)                                                                                                                                                                                                                 |
| Platform connectors (Telegram/Discord/Slack/Lark/OneBot) + A2UI ⇄ IM bridge      | `lib/connectors/`, `app/inbox/`, `src-tauri/src/connectors/`, `src-tauri/src/a2ui_bridge/`     | [0009](./docs/content/docs/en/adr/0009-platform-connectors.md), [0025 (A2UI)](./docs/content/docs/en/adr/0025-a2ui-im-bridge.md)                                                                                                                                           |
| Unified subscription module (Claude / Codex / OpenCode)                          | `lib/subscription/`, `src-tauri/src/subscription/`, `components/settings/subscription/`        | [0010](./docs/content/docs/en/adr/0010-claude-subscription-oauth.md), [0025](./docs/content/docs/en/adr/0025-unified-subscription-module.md)                                                                                                                               |
| Visual workflows (React Flow editor + hybrid TS/Rust runtime)                    | `lib/workflow/`, `types/workflow/visual.ts`, `components/workflow/`, `src-tauri/src/workflow/` | [0011](./docs/content/docs/en/adr/0011-workflows-subsystem.md)                                                                                                                                                                                                             |
| Transport abstraction                                                            | `lib/tauri/transport-*.ts`                                                                     | [0012](./docs/content/docs/en/adr/0012-transport-abstraction.md)                                                                                                                                                                                                           |
| Command manifest                                                                 | `lib/slash-commands/`, `lib/skills/`                                                           | [0013](./docs/content/docs/en/adr/0013-command-manifest.md)                                                                                                                                                                                                                |
| Capacitor mobile shell + V2 headless server                                      | `mobile/`, `lib/mobile/`, `lib/api/v1/`, `src-tauri/src/bin/cognia-server.rs`                  | [0014](./docs/content/docs/en/adr/0014-capacitor-mobile-shell.md), [0015](./docs/content/docs/en/adr/0015-mobile-v2-completion.md)                                                                                                                                         |
| GitHub Delivery (PR review / Issue→PR / Release as policy-gated workflows)       | `lib/github/`, `plugins/github-delivery/`                                                      | [0018](./docs/content/docs/en/adr/0018-github-delivery.md)                                                                                                                                                                                                                 |
| `/goal` command (self-driving chat loop)                                         | `lib/goal/`, `components/goal/`, `lib/slash-commands/actions/goal.ts`                          | [0019](./docs/content/docs/en/adr/0019-goal-command.md)                                                                                                                                                                                                                    |
| Computer Use (Anthropic native tools + per-platform automation)                  | `src-tauri/src/automation/`, `lib/automation/`, `plugins/computer-use/`                        | [0020](./docs/content/docs/en/adr/0020-computer-use-completeness.md)                                                                                                                                                                                                       |
| WebRTC DataChannel WAN transport + signaling server                              | `signaling-server/`, `lib/signaling/`, `lib/tauri/transport-rtc.ts`                            | [0021](./docs/content/docs/en/adr/0021-webrtc-datachannel-wan-transport.md)                                                                                                                                                                                                |
| Agent-team runtime hardening (BudgetGuard, TeammatePool, ConcurrencyController)  | `lib/agent-team/`, `src-tauri/src/agents/`                                                     | [0022](./docs/content/docs/en/adr/0022-agent-team-runtime-hardening.md)                                                                                                                                                                                                    |
| OCR subsystem (17 providers + Dexie result cache + PDF text-layer fast-path)     | `lib/ocr/`, `lib/db/ocr-results.ts`, `src-tauri/src/ocr/`, `plugins/ocr/`                      | [0024](./docs/content/docs/en/adr/0024-ocr-subsystem.md)                                                                                                                                                                                                                   |

## Tech stack

| Layer            | Tools                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend         | Next.js 16 (App Router, static export), React 19, TypeScript 5, Tailwind v4 (`@tailwindcss/postcss`), shadcn/ui (`new-york`), Radix UI, `next-intl`                                                   |
| State / data     | Zustand 5, Dexie 4 + `dexie-react-hooks`, `zundo`, React Hook Form, Zod 4                                                                                                                             |
| Editor / visuals | React Flow (`@xyflow/react`), Monaco, CodeMirror, Mermaid, KaTeX, three / r3f, Recharts, `motion`                                                                                                     |
| AI               | `ai` (Vercel AI SDK v6), `@ai-sdk/{anthropic,openai,google,mistral,cohere}`, `@modelcontextprotocol/sdk`, `@anthropic-ai/claude-agent-sdk` (sidecar), `@opencode-ai/sdk`, `@huggingface/transformers` |
| Desktop core     | Tauri 2.11, Rust 1.84.1+, `axum` (companion / MCP HTTP), `tokio`, `rusqlite` + `sqlite-vec`, `webrtc-rs`, `wasmtime` 26 (+ WASI), `keyring`, `git2`, `qdrant-client`, optional `ocrs` / `oar-ocr`     |
| Mobile shell     | Capacitor 7 (iOS / Android), `@capacitor-mlkit/barcode-scanning`, biometric / secure storage / voice-recorder plugins                                                                                 |
| Sidecar          | Node 20+ ESM, Anthropic Claude Agent SDK, AI SDK providers, `fast-glob`, `diff`                                                                                                                       |
| Quality          | Jest 30 + RTL, Playwright (E2E, mobile, Tauri), ESLint 9, Prettier 3, Husky + lint-staged + commitlint (`config-conventional`)                                                                        |
| Docs             | Fumadocs (`docs/`, port 3001)                                                                                                                                                                         |

## Prerequisites

### For the web / desktop app

- **Node.js** 20.x or later
- **pnpm** 10.x (the lockfile is pnpm-only; do not use npm/yarn at the workspace root)
  ```bash
  npm install -g pnpm
  ```
- **Rust** 1.84.1 or later (Tauri MSRV, raised by the optional `ocr-paddle` feature)
  ```bash
  rustc --version
  cargo --version
  ```
- Platform build deps:
  - **Windows** — Visual Studio C++ Build Tools (`Desktop development with C++`)
  - **macOS** — Xcode Command Line Tools
  - **Linux** — see [Tauri prerequisites](https://tauri.app/start/prerequisites/)

### For the mobile shell

- **Xcode** 15+ (iOS) or **Android Studio** Hedgehog+ (Android)
- CocoaPods (`brew install cocoapods`) on macOS for iOS builds
- A successful `pnpm build` first — the Capacitor shell wraps `../out`

### For optional features

- **Cloudflared** — auto-spawned by Tauri's shell plugin for the GitHub Delivery webhook receiver
- **TURN credentials** — only if you self-host WebRTC TURN (stored in OS keyring, never plaintext)
- **CMake + C++ toolchain** — only if you build the `ocr-tesseract` feature

## Installation

```bash
git clone https://github.com/AstroAir/cognia-next
cd cognia-next

# Install workspace (main app + docs + mobile + plugin-sdk/typescript)
pnpm install

# Install the Node sidecar (separate package, no workspace)
pnpm sidecar:install

# Build the bundled VS Code extension-host sidecar
pnpm sidecars:build

# Copy Monaco editor assets (also runs automatically via predev/prebuild)
pnpm monaco:copy
```

Husky installs the `pre-commit` (lint-staged) and `commit-msg` (commitlint) hooks via the root `prepare` script — no extra step needed.

## Development

### Web (browser, port 3000)

```bash
pnpm dev
```

Open <http://localhost:3000>. `predev` copies Monaco assets automatically.

### Desktop (Tauri)

```bash
pnpm tauri dev      # starts Next.js + launches the Tauri window
pnpm tauri info     # print Tauri/Rust toolchain info
pnpm tauri build    # production desktop bundle
```

Tauri's `beforeDevCommand` is `pnpm dev` and `beforeBuildCommand` is `pnpm build`; both shells consume `out/`.

### Mobile (Capacitor)

```bash
pnpm build              # produces out/ first — required
pnpm mobile:sync        # copy out/ into the native iOS/Android projects
pnpm mobile:open:ios    # opens Xcode
pnpm mobile:open:android # opens Android Studio
```

For LAN/WAN connectivity to a desktop instance see ADR-0014 / ADR-0021 and the `app/(mobile-onboard)/` flow.

### Docs (Fumadocs, port 3001)

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:start
```

The docs site is a full Next.js server app, independent from the main app's static export.

### Sidecars

```bash
pnpm sidecar:start          # run the Claude Code host sidecar standalone
pnpm sidecar:smoke          # smoke test
pnpm sidecar:test           # node --test sidecar/builtin-tools + dispatch
pnpm sidecar:vscode:build   # build the VS Code extension-host sidecar
```

### Signaling server

```bash
pnpm webrtc:smoke           # smoke test the signaling-server WebSocket protocol
```

The signaling-server itself is a standalone Node package — see `signaling-server/README.md`.

## Available scripts

### Frontend

| Command                                                                                  | Description                                                             |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm dev`                                                                               | Next.js dev server on port 3000                                         |
| `pnpm build`                                                                             | Production build → `out/` (static export consumed by Tauri & Capacitor) |
| `pnpm start`                                                                             | Next.js production server                                               |
| `pnpm lint` / `lint:fix`                                                                 | ESLint 9                                                                |
| `pnpm format` / `format:check`                                                           | Prettier 3                                                              |
| `pnpm typecheck`                                                                         | TypeScript no-emit type-check                                           |
| `pnpm test` / `test:watch` / `test:coverage`                                             | Jest 30 with React Testing Library                                      |
| `pnpm test:e2e`                                                                          | Playwright (all projects)                                               |
| `pnpm test:e2e:workflows` / `:workflows:nodes` / `:workflows:editor` / `:workflows:runs` | Workflow editor / runtime suites                                        |
| `pnpm test:e2e:mobile` / `:mobile:ios`                                                   | Mobile viewport / iOS WebKit                                            |
| `pnpm test:e2e:tauri`                                                                    | Drives the actual Tauri debug bundle                                    |
| `pnpm test:e2e:install` / `:report`                                                      | Install Chromium+WebKit / open HTML report                              |
| `pnpm monaco:copy`                                                                       | Copy Monaco worker assets into `public/`                                |

### Repo gates

| Command                                            | Description                                               |
| -------------------------------------------------- | --------------------------------------------------------- |
| `pnpm audit:slots`                                 | Validate the plugin slot manifest                         |
| `pnpm audit:silent-flags`                          | Detect silent-failure code paths                          |
| `pnpm lint:i18n`                                   | Diff `i18n/messages/{en,zh-CN}.json` against the baseline |
| `pnpm lint:i18n:baseline`                          | Rewrite the i18n baseline after intentional changes       |
| `pnpm sync:plugin-sdk-wit` / `lint:plugin-sdk-wit` | Keep the plugin SDK WIT bindings in sync                  |

### Tauri / Mobile / Docs

| Command                                                        | Description          |
| -------------------------------------------------------------- | -------------------- |
| `pnpm tauri dev` / `build` / `info`                            | Tauri desktop        |
| `pnpm mobile:sync` / `mobile:open:ios` / `mobile:open:android` | Capacitor mobile     |
| `pnpm docs:dev` / `docs:build` / `docs:start`                  | Fumadocs (port 3001) |

### Sidecars / WebRTC

| Command                                                       | Description                                 |
| ------------------------------------------------------------- | ------------------------------------------- |
| `pnpm sidecar:install` / `sidecar:start` / `sidecar:smoke`    | Claude Code host sidecar                    |
| `pnpm sidecar:test` (`:builtin` + `:dispatch`)                | `node --test` suites                        |
| `pnpm sidecar:vscode:install` / `:build` / `:test` / `:clean` | VS Code extension-host sidecar              |
| `pnpm sidecars:install` / `sidecars:build` / `sidecars:test`  | All sidecars                                |
| `pnpm webrtc:smoke`                                           | Smoke test the signaling-server WS protocol |

### Adding shadcn/ui components

```bash
pnpm dlx shadcn@latest add card
pnpm dlx shadcn@latest add button card dialog
```

## Project structure

```
cognia-next/
├── app/                      # Next.js App Router
│   ├── (mobile-onboard)/    # Mobile onboarding route group
│   ├── a2ui/  agent-teams/  canvas/  discover/
│   ├── github-delivery/  inbox/  logs/  me/
│   ├── plugins/  scheduler/  settings/  share-target/
│   ├── skills/  twin/  workflows/
│   └── layout.tsx           # Root layout (TooltipProvider, next-intl provider)
├── components/
│   ├── ui/                  # 57 pre-installed shadcn/ui primitives (no tests)
│   ├── ai-elements/         # Vendored AI Elements (no tests)
│   ├── automation/  chat/  connectors/  goal/  inbox/
│   ├── plugins/  settings/  twin/  workflow/  workflows/
│   └── …                    # All other first-party components ship with *.test.tsx
├── hooks/                    # Reusable React hooks
├── lib/                      # All business logic
│   ├── a2ui/  agent-team/  ai-sdk/  automation/
│   ├── claude/  connectors/  data/  db/  external-bridge/
│   ├── github/  goal/  mobile/  ocr/  plugin/  scheduler/
│   ├── signaling/  skills/  slash-commands/  subscription/
│   ├── tauri/  twin/  vector/  wiki/  workflow/  …
│   ├── browser-stubs/       # Empty stubs for server-only deps
│   └── utils.ts             # cn() = clsx + tailwind-merge
├── plugins/                  # In-tree first-party plugins
│   ├── anthropic-skills/  clipboard-history/  clipboard-tools/
│   ├── computer-use/  e2b-sandbox/  github-delivery/  ocr/
│   ├── playwright-mcp/  prompt-templates/  screenshot/
│   ├── stagehand-mcp/  test-lsp-contribution/
│   ├── wasm-example-formatter/  web-tools/  workflow-ai/
│   └── workspace-tools/
├── plugin-sdk/typescript/    # Published plugin SDK (workspace package)
├── i18n/                     # next-intl
│   ├── request.ts  config.ts
│   └── messages/en.json  messages/zh-CN.json
├── src-tauri/                # Tauri 2.11 Rust core
│   ├── src/
│   │   ├── automation/  canvas/  ccswitch/  claude/
│   │   ├── companion_api/  connectors/  external_agent/
│   │   ├── hooks/  logging/  mcp_server/  plugin_api/
│   │   ├── proxy_config/  remote_control/  scheduler/
│   │   ├── skills/  subscription/  tts/  vector/
│   │   ├── wallpaper/  workflow/  a2ui_bridge/
│   │   ├── bin/cognia-server.rs   # Headless V2 server binary
│   │   ├── main.rs  lib.rs  commands.rs  menu.rs
│   │   └── …
│   ├── icons/  capabilities/  resources/
│   ├── tauri.conf.json
│   └── Cargo.toml
├── sidecar/                  # Node sidecar (NOT in pnpm workspace)
│   ├── claude-host.mjs       # Claude Agent SDK host
│   ├── a2ui-mcp.mjs          # A2UI bridge MCP server
│   ├── dispatch/  builtin-tools/  fetch-interceptor.mjs
│   ├── vscode-ext-host/      # VS Code extension-host sidecar
│   └── package.json          # Separate lockfile, separate install
├── mobile/                   # Capacitor 7 shell (workspace package)
├── docs/                     # Fumadocs site (workspace package, port 3001)
│   └── content/docs/{en,zh}/adr/   # Architecture Decision Records
├── signaling-server/         # Standalone WebRTC rendezvous service
├── tests/e2e/                # Playwright suites (workflows, mobile, tauri)
├── scripts/                  # Build/audit helpers (copy-monaco, audit-slots,
│                             #   lint-i18n, build-vscode-ext-host-sidecar, …)
├── components.json           # shadcn/ui config
├── next.config.ts            # withNextIntl + static export + Node-builtin stubs
├── pnpm-workspace.yaml       # docs, mobile, plugin-sdk/typescript
└── package.json
```

## Configuration

### Environment variables

```bash
cp .env.example .env.local
```

- Variables prefixed `NEXT_PUBLIC_` are exposed to the browser
- Never commit `.env.local`
- `lib/env.ts` validates required vars at first access

### Tauri configuration

`src-tauri/tauri.conf.json` already ships sensible defaults for Cognia:

- `productName: "Cognia"`, identifier `com.reactquickstarter.desktop`
- Deep link scheme: `cognia://`
- Custom title bar (`decorations: false`, overlay traffic lights on macOS)
- Hard CSP locked to `'self'` + `ipc:`, no remote script/style sources
- Bundled sidecar resources: `claude-host.mjs`, `a2ui-mcp.mjs`, the VS Code extension-host build, and their `node_modules`
- CLI args: optional `workspace` path + `--new-chat` / `-n` flag

### Path aliases

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

- `@tailwindcss/postcss` + CSS variables in `app/globals.css`
- Class-based dark mode (`@custom-variant dark (&:is(.dark *))`)
- oklch color tokens

## Working rules (read before touching code)

The full ruleset lives in `CLAUDE.md`. Highlights:

1. **Research before implementing.** Search `lib/`, `components/`, `hooks/`, `src-tauri/`, and ADRs for existing implementations before writing a new utility, hook, or component.
2. **No simplifications.** Implement the full behavior — no stubs, mocks, or `// TODO later` production paths. Surface blockers instead of silently degrading scope.
3. **Every component ships with a unit test.** Files under `components/**`, `hooks/**`, `lib/**`, or `src-tauri/src/**` need a co-located `*.test.ts(x)` or in-file `#[cfg(test)]` test. Coverage must stay ≥90% lines/branches/functions. `components/ui/` (shadcn) and `components/ai-elements/` (vendored) are excluded.
4. **i18n is mandatory.** No hard-coded user-facing strings in `.tsx`. Use `next-intl`'s `useTranslations()` / `getTranslations()`, add keys to **both** `i18n/messages/en.json` and `i18n/messages/zh-CN.json`, and run `pnpm lint:i18n` to confirm parity. Aria labels, placeholders, toasts and error messages count as user-facing.
5. **Cross-cutting hooks — reuse, don't reinvent.** PII redaction (`lib/twin/ingest/redact.ts`), quiet hours (`lib/connectors/outbound-runner`), the build-options pipeline (`lib/claude/build-options.ts:resolveSendOptions`), and the A2UI ⇄ IM bridge (`lib/connectors/a2ui-bridge/`) are shared entry points — touch them, don't fork them.

## Testing

- **Co-located** — `xxx.test.ts(x)` next to source. No `__tests__/` or `tests/` directories for unit tests.
- **Coverage gate** — ≥90% lines / branches / functions; verify with `pnpm test:coverage`.
- **Rust** — in-file `#[cfg(test)] mod tests { ... }`; integration tests under `src-tauri/tests/`.
- **Sidecar** — `pnpm sidecar:test` uses Node's built-in `node --test` (not Jest).
- **E2E** — Playwright with dedicated projects for `mobile-pixel-7`, `mobile-iphone-13`, and `tauri`. The Tauri project runs a real debug bundle (`pretest:e2e:tauri` builds it first).

## Commit hooks

Husky is wired via the root `prepare` script — `pnpm install` once and it's live.

- `pre-commit` → `lint-staged` (`eslint --fix` + `prettier --write` on staged files)
- `commit-msg` → `commitlint` with `@commitlint/config-conventional`

Never bypass with `--no-verify`. If a hook fails, fix the root cause, re-stage, and create a **new** commit — the failed one was never created, so `--amend` would modify the wrong commit.

## Building for production

### Web / static export

```bash
pnpm build
# → out/  (consumed by Tauri's frontendDist AND by Capacitor's webDir)
```

### Desktop

```bash
pnpm tauri build
# Outputs:
# - Windows: src-tauri/target/release/bundle/msi/  (and nsis/)
# - macOS:   src-tauri/target/release/bundle/dmg/  (and app/)
# - Linux:   src-tauri/target/release/bundle/{appimage,deb,rpm}/
```

Optional OCR features are gated by Cargo feature flags — see `src-tauri/Cargo.toml` for `ocr-tesseract`, `ocr-windows`, `ocr-apple`, `ocr-ocrs`, `ocr-paddle`. Default build ships placeholder backends so the dispatch table compiles everywhere.

### Mobile

```bash
pnpm mobile:sync
pnpm mobile:open:ios       # build / sign / archive in Xcode
pnpm mobile:open:android   # build / sign / bundle in Android Studio
```

### Docs

```bash
pnpm docs:build
# Output: docs/.next/   — deploy to any Node.js host. On Vercel, set root directory to docs/.
```

## Deployment

- **Desktop** — distribute the `.msi` / `.dmg` / `.AppImage` from `src-tauri/target/release/bundle/`. Code-signing is project-specific.
- **Mobile** — submit via App Store Connect / Google Play after `pnpm mobile:sync`.
- **Docs** — `docs/` is a full Next.js server app (NOT static export); deploy to Vercel / Railway / Fly.io / self-hosted Node.
- **Signaling server** — deploy `signaling-server/` to any Node host that supports WebSockets. Set TURN credentials via the OS keyring on the desktop client; never ship them in code.

## Troubleshooting

**Port 3000 already in use**

```powershell
# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 3000 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }
```

```bash
# macOS / Linux
lsof -ti:3000 | xargs kill -9
```

**Tauri build fails**

```bash
pnpm tauri info
rustup update
cd src-tauri && cargo clean
```

**Module not found errors**

```bash
rm -rf .next
rm -rf node_modules docs/node_modules mobile/node_modules pnpm-lock.yaml
pnpm install
pnpm sidecar:install
```

**`Cannot find module 'collections/server'` in docs**

```bash
pnpm docs:dev    # generates docs/.source/ once
```

**i18n parity check fails**

```bash
pnpm lint:i18n             # diff against the baseline
pnpm lint:i18n:baseline    # only after you've intentionally added/removed keys
```

**Monaco assets missing**

```bash
pnpm monaco:copy           # also runs automatically via predev/prebuild
```

## Critical notes

- **pnpm only** — install from the repo root. The lockfile is pnpm-format.
- **Do not remove `output: "export"` in `next.config.ts`** — both Tauri and Capacitor builds consume `out/`. `docs/next.config.ts` is a full server app; keep them separate.
- **Static export caveat** — `app/api/` does not exist at runtime. Anything that needs an HTTP server (MCP HTTP, webhook receiver, cron daemon, headless V2 API) lives in Tauri Rust (axum), not Next.js routes.
- **Server-only packages** — vector-DB SDKs and `simple-git` are aliased to `lib/browser-stubs/empty.js` in `next.config.ts`. Add new server-only deps to **both** `SERVER_ONLY_PACKAGES` and `serverExternalPackages`; truly Node-only built-ins go in `NODE_ONLY_MODULES`. Wrong setup blows up the mobile bundle.
- **Native vector store** — sqlite-vec at `<app_data>/cognia/vectors.sqlite`. Web mode hides the native option and forces a cloud backend.
- **Rust toolchain** — 1.84.1+ (Tauri MSRV is 1.77.2; the `ocr-paddle` opt-in feature raises it).
- **Conventional Commits** are enforced by the `commit-msg` hook.

## Learn more

- **ADRs** — `docs/content/docs/en/adr/` (rendered at <http://localhost:3001> once `pnpm docs:dev` is running)
- **Plugin SDK** — `plugin-sdk/typescript/` + `docs/content/docs/en/plugin-dev/`
- **CLAUDE.md** — full development rules + subsystem map for AI-assisted contributors
- **Tauri** — [Tauri 2 docs](https://tauri.app/)
- **Next.js 16** — [Next.js docs](https://nextjs.org/docs)
- **Fumadocs** — [Fumadocs docs](https://fumadocs.dev/)
- **shadcn/ui** — [shadcn/ui docs](https://ui.shadcn.com/) (`new-york` style, RSC mode)
- **Capacitor 7** — [Capacitor docs](https://capacitorjs.com/docs)

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/your-feature`) — follow `<type>/<short-kebab>` naming
3. Make focused, surgical changes (see Working Rules above)
4. Add or update the co-located tests
5. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and any relevant `pnpm test:e2e:*`
6. Commit with Conventional Commits (the hook will reject non-conforming messages)
7. Open a PR — link related ADRs

## License

MIT — see [LICENSE](./LICENSE).

## Support

- Read the relevant ADR under `docs/content/docs/en/adr/`
- Check the [Troubleshooting](#troubleshooting) section
- Open an issue on GitHub: <https://github.com/AstroAir/cognia-next/issues>
