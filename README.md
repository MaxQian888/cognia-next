<h1 align="center">Cognia</h1>

<p align="center">
  An AI desktop client for Claude Code — with a plugin runtime, visual workflows,
  digital twins, IM connectors, computer-use automation, OCR, and a WAN-grade mobile companion.
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
  <a href="./README_zh.md">中文</a> ·
  <a href="./docs/content/docs/en/adr/">Architecture decisions</a> ·
  <a href="./CLAUDE.md">Working rules</a>
</p>

---

> [!WARNING]
> **This project is undergoing a major refactoring.** APIs, data schemas, and features may change
> or break without notice, and overall availability is **not guaranteed** at this stage. Pin a
> known-good commit if you depend on it.

## Overview

Cognia ships a single Next.js 16 static export to three shells — browser, Tauri 2 desktop, and
Capacitor 8 mobile — sharing one UI, one i18n catalog, and one set of business logic. A Rust core
runs the long-lived services (HTTP, scheduler, vector store, automation, OCR, MCP server), and a
bundled Node sidecar hosts the Claude Agent SDK.

## Features

- **Claude Code, in a desktop app** — chat surface, slash commands, agents, skills, MCP, hooks.
- **Plugin runtime** — 20+ first-party plugins (computer-use, OCR, GitHub delivery, clipboard,
  screenshot, Stagehand/Playwright MCP, e2b sandbox, prompt templates, Zhihu pipeline, …) backed
  by a WASM host (`wasmtime` + WIT bindings).
- **Visual workflows** — React Flow editor with a hybrid TypeScript/Rust runtime; cron, webhook,
  connector, chat, and `/goal`-completed triggers.
- **Employee Digital Twin** — staged ingest, multi-agent distillation, runtime RAG + style
  few-shot, gated by a shared PII redactor.
- **IM connectors** — Telegram, Discord, Slack, Lark, OneBot, WeCom and personal WeChat behind one
  `ConnectorBus`, with quiet-hours, circuit breakers, and an A2UI ⇄ IM bridge that downgrades rich
  content per platform.
- **Computer Use** — Anthropic native tool calls dispatched to per-OS automation (Windows UIA,
  macOS AX, Linux AT-SPI) with a 3-tier permission model and HITL consent overlay.
- **OCR** — 17 providers (cloud-doc, LLM-vision, specialist, Lark, and 5 local backends) behind a
  single `extract()` API with a Dexie-backed cache.
- **Mobile + WAN** — Capacitor client over LAN/HTTPS with mDNS discovery and JWT pairing, plus an
  optional WebRTC tier with a standalone signaling server.
- **Zero-knowledge share links** — Cloudflare Worker + R2/KV, key in URL fragment, decrypted in
  the viewer.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Next.js 16 (App Router, static export → out/)               │
│  app/  components/  hooks/  lib/  plugins/  i18n/            │
└──────────────────────────────────────────────────────────────┘
        │                   │                   │
        ▼                   ▼                   ▼
   Browser dev        Tauri 2 desktop      Capacitor 8 mobile
   (pnpm dev)         (src-tauri/, Rust    (mobile/, wraps
                       core + axum HTTP +   ../out, LAN /
                       scheduler + agents   WAN client of the
                       + automation + OCR)  headless server)
                            │
                            ▼
                    Node sidecar (sidecar/)
                    Claude Agent SDK + A2UI MCP
```

Two standalone services live alongside the monorepo:

- `signaling-server/` — WebRTC rendezvous (axum + workers-rs).
- `share-server/` — Cloudflare Worker + Vite viewer for public share links.

The full subsystem catalogue, with one ADR per topic, lives under
[`docs/content/docs/en/adr/`](./docs/content/docs/en/adr/).

## Quick start

```bash
git clone https://github.com/MaxQian888/cognia-next
cd cognia-next
pnpm install                   # workspace (main + docs + mobile + plugin-sdk)
pnpm sidecar:install           # Node sidecar (separate lockfile)
pnpm dev                       # browser dev server → http://localhost:3000
```

For the desktop and mobile shells:

```bash
pnpm tauri dev                 # desktop window
pnpm build && pnpm mobile:sync # mobile (then mobile:open:ios / :android)
```

> Husky hooks are wired automatically through the root `prepare` script — no extra setup.

## Requirements

| Target  | Requirements                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------ |
| Web     | Node.js ≥ 20, pnpm 10                                                                                  |
| Desktop | Rust ≥ 1.84.1 (Tauri 2) + platform C/C++ toolchain ([prereqs](https://tauri.app/start/prerequisites/)) |
| Mobile  | Xcode 15+ (iOS) or Android Studio Hedgehog+ (Android); CocoaPods for iOS                               |

Optional: `cloudflared` (auto-spawned for the GitHub Delivery webhook), TURN credentials for
self-hosted WebRTC, CMake/C++ for the `ocr-tesseract` Cargo feature.

## Project layout

```
cognia-next/
├── app/                   Next.js App Router (static export)
├── components/            React components (ui/ = shadcn, ai-elements/ = vendored)
├── hooks/  lib/  types/   Business logic, hooks, shared types
├── plugins/               First-party in-tree plugins
├── plugin-sdk/typescript/ Published plugin SDK (workspace package)
├── i18n/                  next-intl request + messages (en, zh-CN)
├── src-tauri/             Tauri 2 Rust core (axum HTTP, scheduler, automation, OCR, …)
├── sidecar/               Node sidecar (Claude Agent SDK host, A2UI MCP) — separate lockfile
├── mobile/                Capacitor 8 shell (workspace package)
├── docs/                  Fumadocs site + ADRs (workspace package, port 3001)
├── signaling-server/      Standalone WebRTC rendezvous service
├── share-server/          Cloudflare Worker + Vite viewer for share links
├── tests/e2e/             Playwright suites (workflows, mobile, tauri)
└── scripts/               Build, audit, and migration helpers
```

## Scripts

```bash
# App
pnpm dev | build | start | lint | format | typecheck
pnpm test | test:watch | test:coverage

# Desktop
pnpm tauri dev | build | info

# Mobile (run pnpm build first — Capacitor wraps out/)
pnpm mobile:sync
pnpm mobile:open:ios | mobile:open:android

# Docs (Fumadocs, port 3001)
pnpm docs:dev | docs:build | docs:start

# Sidecars
pnpm sidecar:install | sidecar:start | sidecar:smoke | sidecar:test
pnpm sidecars:build                       # all sidecars

# E2E (Playwright)
pnpm test:e2e                             # all projects
pnpm test:e2e:workflows | :mobile | :tauri
pnpm test:e2e:install | :report

# Repo gates
pnpm audit:slots                          # plugin slot manifest
pnpm audit:silent-flags                   # silent-failure code paths
pnpm lint:i18n | lint:i18n:baseline       # next-intl key parity
pnpm lint:plugin-sdk-wit                  # plugin SDK WIT bindings

# Other
pnpm webrtc:smoke                         # signaling-server protocol smoke test
pnpm dlx shadcn@latest add <component>
```

## Configuration

- **Environment** — `cp .env.example .env.local`. `NEXT_PUBLIC_*` vars are exposed to the browser;
  `lib/env.ts` validates required vars at first access. Never commit `.env.local`.
- **Tauri** — `src-tauri/tauri.conf.json` defines product name (`Cognia`), identifier
  (`com.reactquickstarter.desktop`), deep-link scheme (`cognia://`), a hard `'self'` CSP, the
  custom title bar, and the bundled sidecar resources.
- **Path aliases** — `@/components`, `@/lib`, `@/ui`, `@/hooks`, `@/utils`.
- **Styling** — Tailwind v4 via `@tailwindcss/postcss`, oklch CSS variables, class-based dark
  mode (`@custom-variant dark (&:is(.dark *))`).

## Conventions

These are project-level hard rules — see [`CLAUDE.md`](./CLAUDE.md) for the full ruleset.

1. **Research before implementing.** Search `lib/`, `components/`, `hooks/`, `src-tauri/`, and the
   relevant ADR before writing a new utility, hook, or component. Reuse first.
2. **No silent simplifications.** Ship the full behavior or surface the blocker — never stub,
   mock, or `// TODO later` a production path.
3. **Tests are not optional.** Every new file under `components/**`, `hooks/**`, `lib/**`, or
   `src-tauri/src/**` (excluding `components/ui/` and `components/ai-elements/`) ships with a
   co-located test. Coverage stays ≥ 90 % lines / branches / functions.
4. **i18n is mandatory.** No hard-coded user-facing strings in `.tsx`. Add keys to **both**
   `i18n/messages/en.json` and `i18n/messages/zh-CN.json`, then `pnpm lint:i18n`.
5. **Reuse shared hooks.** PII redaction (`lib/twin/ingest/redact.ts`), quiet-hours
   (`lib/connectors/outbound-runner`), the build-options pipeline
   (`lib/claude/build-options.ts`), and the A2UI ⇄ IM bridge (`lib/connectors/a2ui-bridge/`) are
   shared entry points — touch them, don't fork them.

## Testing

- **Co-located** — `*.test.ts(x)` next to source; no `__tests__/` or `tests/` directories for
  unit tests.
- **Coverage** — `pnpm test:coverage` (Jest 30 + RTL).
- **Rust** — in-file `#[cfg(test)] mod tests { … }`; integration tests under `src-tauri/tests/`.
- **Sidecar** — `pnpm sidecar:test` (Node's built-in `node --test`, not Jest).
- **E2E** — Playwright with dedicated projects for `mobile-pixel-7`, `mobile-iphone-13`, and
  `tauri`. The Tauri project drives a real debug bundle (`pretest:e2e:tauri` builds it first).

## Commit hooks

- `pre-commit` → `lint-staged` (`eslint --fix` + `prettier --write` on staged files).
- `commit-msg` → `commitlint` (`@commitlint/config-conventional`) — Conventional Commits enforced.

Never bypass with `--no-verify`. If a hook fails, fix the root cause, re-stage, and create a
**new** commit — the failed commit was never created, so `--amend` would modify the wrong one.

## Building

```bash
# Web / static export → out/  (consumed by Tauri and Capacitor)
pnpm build

# Desktop → target/release/bundle/{msi,nsis,dmg,app,appimage,deb,rpm}/
pnpm tauri build

# Mobile — sync, then sign and archive in Xcode / Android Studio
pnpm mobile:sync
pnpm mobile:open:ios | mobile:open:android

# Docs (Next.js server app) → docs/.next/
pnpm docs:build
```

Optional OCR backends are gated by Cargo feature flags — see `src-tauri/Cargo.toml` for
`ocr-tesseract`, `ocr-windows`, `ocr-apple`, `ocr-ocrs`, `ocr-paddle`. The default build ships
placeholder backends so the dispatch table compiles everywhere.

## Tech stack

| Layer        | Tools                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Frontend     | Next.js 16, React 19, TypeScript, Tailwind v4, shadcn/ui (`new-york`), Radix UI, `next-intl`                                         |
| State / data | Zustand 5, Dexie 4 + `dexie-react-hooks`, `zundo`, React Hook Form, Zod 4                                                            |
| Editor / viz | React Flow, Monaco, CodeMirror, Mermaid, KaTeX, three / r3f, Recharts, `motion`                                                      |
| AI           | Vercel AI SDK v6, `@ai-sdk/*` providers, `@modelcontextprotocol/sdk`, `@anthropic-ai/claude-agent-sdk` (sidecar), `@opencode-ai/sdk` |
| Desktop core | Tauri 2.11, Rust 1.84.1+, `axum`, `tokio`, `rusqlite` + `sqlite-vec`, `webrtc-rs`, `wasmtime` 26, `keyring`, `git2`                  |
| Mobile       | Capacitor 8 (iOS / Android), barcode scanner, biometric / secure-storage / voice-recorder plugins                                    |
| Sidecar      | Node 20+ ESM, Claude Agent SDK, AI SDK providers                                                                                     |
| Quality      | Jest 30 + RTL, Playwright, ESLint 9, Prettier 3, Husky + lint-staged + commitlint                                                    |

## Critical notes

- **pnpm only** — install from the repo root. The lockfile is pnpm-format.
- **Do not remove `output: "export"` in `next.config.ts`** — both Tauri and Capacitor consume
  `out/`. `docs/next.config.ts` is a full server app; keep them separate.
- **No `app/api/` at runtime.** HTTP servers (MCP HTTP, webhook receiver, headless V2 API) live
  in Tauri Rust (axum), not Next.js routes.
- **Server-only deps** — vector-DB SDKs and `simple-git` are aliased to
  `lib/browser-stubs/empty.js`. Add new server-only deps to both `SERVER_ONLY_PACKAGES` and
  `serverExternalPackages`; truly Node-only built-ins go in `NODE_ONLY_MODULES`.

## Troubleshooting

| Symptom                                        | Fix                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port 3000 already in use                       | Windows: `Get-NetTCPConnection -LocalPort 3000 \| % { Stop-Process -Id $_.OwningProcess -Force }` · macOS/Linux: `lsof -ti:3000 \| xargs kill -9` |
| Tauri build fails                              | `pnpm tauri info && rustup update && (cd src-tauri && cargo clean)`                                                                               |
| Module not found                               | `rm -rf node_modules docs/node_modules mobile/node_modules pnpm-lock.yaml && pnpm install`                                                        |
| Docs `Cannot find module 'collections/server'` | `pnpm docs:dev` once to generate `docs/.source/`                                                                                                  |
| i18n parity check fails                        | `pnpm lint:i18n` to diff · `pnpm lint:i18n:baseline` after intentional changes                                                                    |
| Monaco assets missing                          | `pnpm monaco:copy` (also runs via `predev` / `prebuild`)                                                                                          |

## Contributing

1. Fork and create a feature branch — `<type>/<short-kebab>` (e.g. `feat/connector-wecom`).
2. Make focused, surgical changes — see [Conventions](#conventions).
3. Add or update co-located tests.
4. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and any relevant `pnpm test:e2e:*`.
5. Commit with Conventional Commits and open a PR linking related ADRs.

## Learn more

- **ADRs** — [`docs/content/docs/en/adr/`](./docs/content/docs/en/adr/) (rendered at
  <http://localhost:3001> once `pnpm docs:dev` is running)
- **Plugin SDK** — [`plugin-sdk/typescript/`](./plugin-sdk/typescript/)
- **Working rules** — [`CLAUDE.md`](./CLAUDE.md)
- **External docs** — [Tauri 2](https://tauri.app/) · [Next.js 16](https://nextjs.org/docs) ·
  [shadcn/ui](https://ui.shadcn.com/) · [Capacitor](https://capacitorjs.com/docs) ·
  [Fumadocs](https://fumadocs.dev/)

## License

[AGPL-3.0-or-later](./LICENSE).

## Support

- Read the relevant ADR under [`docs/content/docs/en/adr/`](./docs/content/docs/en/adr/).
- File an issue: <https://github.com/MaxQian888/cognia-next/issues>.
