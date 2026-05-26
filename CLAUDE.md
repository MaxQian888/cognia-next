# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Next.js 16 (React 19) + Tauri 2.9 + Capacitor 7 + TypeScript + Tailwind v4 + shadcn/ui + Zustand. The same Next.js static export feeds three shells: the browser (`pnpm dev`), the Tauri desktop app (`pnpm tauri dev`), and the Capacitor mobile shell (`pnpm mobile:sync`).

## Working Rules (read before touching code)

These are project-level hard rules. They override any default behavior to the contrary.

1. **Research before implementing.** Before writing any new code, search `lib/`, `components/`, `hooks/`, `src-tauri/`, and the relevant ADR for an existing implementation. Reuse — don't reimplement. If you think you need a new utility/component/hook, first prove (with grep results or file paths) that no equivalent exists. The Subsystem Map and **Cross-cutting hooks** section below list the most reused entry points; check them first.
2. **No simplifications.** Implement the full behavior the task requires. Do not stub, mock-out, abbreviate, or "// TODO later" production paths. Do not strip error handling, validation, or edge cases to ship faster. If something genuinely cannot be implemented now, stop and surface the blocker — do not silently degrade scope.
3. **Every component ships with a unit test.** Any new file under `components/**`, `hooks/**`, `lib/**`, or `src-tauri/src/**` (excluding `components/ui/` and `components/ai-elements/`) must have a co-located `*.test.ts(x)` / in-file `#[cfg(test)]` test. Coverage must stay ≥90% lines/branches/functions; verify with `pnpm test:coverage` before claiming done. Editing an existing component? Update or add tests in the same change.
4. **Every frontend component is i18n-wired.** No hard-coded user-facing strings in `.tsx`. Use `useTranslations()` / `getTranslations()` from `next-intl`, add the new keys to **both** `i18n/messages/en.json` and `i18n/messages/zh-CN.json`, and run `pnpm lint:i18n` to confirm parity with the baseline. Aria labels, placeholders, toasts, and error messages count as user-facing.
5. **Language convention.** Internal narration (status updates, tool-call rationale, end-of-turn summaries, code comments) is written in **English**. Questions to the user — clarifications, `AskUserQuestion` prompts, confirmation requests — are written in **Chinese**.

## Development Commands

```bash
# Frontend (port 3000)
pnpm dev / build / start / lint / lint:fix / format / format:check / typecheck

# Jest tests (co-located *.test.ts(x))
pnpm test / test:watch / test:coverage

# Tauri desktop
pnpm tauri dev / build / info

# Capacitor mobile (run after `pnpm build` so out/ is fresh)
pnpm mobile:sync / mobile:open:ios / mobile:open:android

# Docs (Fumadocs, port 3001)
pnpm docs:dev / docs:build / docs:start

# Repo-specific gates
pnpm audit:slots        # plugin slot manifest audit
pnpm lint:i18n          # diff against the i18n key baseline
pnpm lint:i18n:baseline # rewrite the i18n baseline after intentional changes
pnpm sidecar:test       # node --test on sidecar/builtin-tools/

# shadcn/ui
pnpm dlx shadcn@latest add <component>

# Run a single Jest file
pnpm test -- path/to/file.test.ts
```

`predev` / `prebuild` run `scripts/copy-monaco-assets.mjs` automatically — don't import Monaco assets manually.

## Architecture

### Workspaces (`pnpm-workspace.yaml`)

| Package  | Path      | Port | Mode                                                         |
| -------- | --------- | ---- | ------------------------------------------------------------ |
| Main app | `/`       | 3000 | static export (`out/`) — consumed by Tauri **and** Capacitor |
| Docs     | `docs/`   | 3001 | full Next.js server (Fumadocs)                               |
| Mobile   | `mobile/` | —    | Capacitor 7 shell over `../out`                              |

Install from repo root only — single `pnpm-lock.yaml`.

`sidecar/` is **not** in the workspace: it is a separate Node project (`cognia-claude-sidecar`) with its own `package.json` and lockfile. The root `pnpm sidecar:test` script just shells into it.

### Main app

- `app/` Next.js App Router (static-exported — `app/api/` does **not** exist at runtime)
- `components/ui/` — 57 pre-installed shadcn/ui components (**no tests**); `TooltipProvider` already mounted in `app/layout.tsx`
- `components/ai-elements/` — vendored (**no tests**)
- `hooks/`, `lib/utils.ts` (`cn()` = clsx + tailwind-merge)
- `i18n/` next-intl wiring (`request.ts`, `config.ts`, `messages/{en,zh-CN}.json`) — `i18n.request.ts` is plugged in via `withNextIntl(...)` in `next.config.ts`
- `plugins/` in-tree first-party plugins (`computer-use`, `github-delivery`, `clipboard-history`, `screenshot`, `web-tools`, …) — loaded by the plugin manager, not as npm packages
- `sidecar/` Node sidecar bundled by Tauri (`claude-host.mjs`, `dispatch/`, `builtin-tools/`, `fetch-interceptor.mjs`); reads `CLAUDE_CODE_OAUTH_TOKEN` from keyring

### Docs (`docs/`)

- Import conventions: `@/lib/source` (NOT `@/app/source`); `collections/server` (tsconfig alias → `.source/`); `fumadocs-ui/provider/next`
- `docs/.source/` auto-generated — run `pnpm docs:dev` or `pnpm docs:build` once so TS can resolve `collections/server`

### Tauri

- `src-tauri/` Rust backend; `tauri.conf.json` → `frontendDist: ../out`
- `beforeDevCommand`: `pnpm dev`; `beforeBuildCommand`: `pnpm build`

### Styling

- Tailwind v4 via `@tailwindcss/postcss`; oklch CSS vars in `globals.css`
- Dark mode: class-based; `@custom-variant dark (&:is(.dark *))`

### Path Aliases

`@/components` `@/lib` `@/utils` `@/ui` `@/hooks`

## Code Patterns

```tsx
import { cn } from "@/lib/utils"
cn("base", condition && "conditional", className)

<Button asChild><Link href="/x">Click</Link></Button>

import { greet, isTauri } from "@/lib/tauri"
if (isTauri()) greet("World").then(console.log)
```

## Subsystem Map

One line per subsystem — the **full detail lives in the ADR** under `docs/content/docs/en/adr/`. Read the ADR before any non-trivial change; use `Lives in` for reuse lookups.

| Subsystem                  | Lives in                                                                                                                                                       | Schema           | ADR              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------- |
| Data backup / transfer     | `lib/data/`, `components/settings/data/`, `lib/db/backup-history.ts`                                                                                           | —                | 0001             |
| Employee Digital Twin      | `lib/twin/`, `types/twin/`, `components/twin/`, `app/twin/`                                                                                                    | v14              | 0003             |
| External Bridge            | `lib/external-bridge/`, `lib/wiki/`, `src-tauri/src/mcp_server/`                                                                                               | v17              | 0008             |
| Platform Connectors        | `lib/connectors/`, `lib/a2ui/connector-callback-handler.ts`, `app/inbox/`, `components/inbox/`, `src-tauri/src/connectors/`                                    | v39              | 0009, 0025, 0036 |
| Unified Subscription       | `lib/subscription/`, `src-tauri/src/subscription/`, `components/settings/subscription/`                                                                        | keyring v2 / v20 | 0025             |
| Visual Workflows           | `lib/workflow/`, `types/workflow/visual.ts`, `components/workflow/`, `src-tauri/src/workflow/`                                                                 | v22              | 0011             |
| Plugin Dexie Tables        | `lib/plugin/dexie/`, `lib/plugin/api/dexie-api.ts`                                                                                                             | v27              | dexie-tables.mdx |
| GitHub Delivery            | `lib/github/`, `plugins/github-delivery/`                                                                                                                      | —                | 0018             |
| Capacitor mobile           | `mobile/`, `lib/mobile/`, `lib/api/v1/`                                                                                                                        | —                | 0014, 0015       |
| /goal Command              | `lib/goal/`, `components/goal/`, `lib/slash-commands/actions/goal.ts`                                                                                          | v30              | 0019             |
| Computer Use               | `src-tauri/src/automation/`, `lib/automation/`, `components/automation/`, `plugins/computer-use/`                                                              | v32              | 0020             |
| WebRTC WAN transport       | `signaling-server/`, `lib/signaling/`, `lib/tauri/transport-rtc.ts`, `components/settings/companion/webrtc-card.tsx`                                           | v33              | 0021             |
| OCR subsystem              | `lib/ocr/`, `lib/db/ocr-results.ts`, `lib/slash-commands/actions/ocr.ts`, `components/settings/ocr/`, `hooks/use-ocr.ts`, `plugins/ocr/`, `src-tauri/src/ocr/` | v36              | 0024             |
| Mobile sync orchestrator   | `lib/sync/`, `hooks/data/use-dexie-first-query.ts`, `lib/connectivity/`, `lib/capacitor/`, `components/mobile/`, `app/{sw,manifest}.ts`                        | v46              | 0027             |
| Agent Team                 | `lib/ai/agent/`, `lib/claude/agents/subagents/`, `lib/plugin/registries/`, `components/agent/workspace/`, `stores/agent/agent-team-store/`                     | v2 persist       | 0022, 0032       |
| Integrated terminal        | `lib/terminal/`, `components/terminal/`, `stores/terminal/`, `src-tauri/src/terminal/`, `src-tauri/src/companion_api/ws_terminal.rs`                           | persist          | 0031, 0033       |
| Rust performance dashboard | `src-tauri/src/perf/`, `lib/perf/backend/`, `hooks/perf/use-perf-stream.ts`, `components/performance/`, `app/performance/`                                     | —                | 0035             |
| Public share links         | `lib/share/`, `lib/db/shared-links.ts`, `components/share/`, `share-server/worker/`, `share-server/viewer/`                                                    | v54              | 0037             |

### Cross-cutting hooks (reuse, don't reinvent)

- **PII redaction**: `lib/twin/ingest/redact.ts:hasNoLeakingPii` is the gate before any LLM/embed call (encrypted master key in `lib/twin/ingest/redaction-key.ts`). Shared by Twin, Goal, Connector auto-mode (`lib/connectors/ai-loop/safe-send-prompt.ts`), and Agent Team shared-memory.
- **Quiet hours**: `lib/connectors/outbound-runner.isInQuietHours` / `msUntilQuietEnd` exported; reused by the GitHub Delivery policy gate.
- **Build-options pipeline**: `lib/claude/build-options.ts:resolveSendOptions` is where A2UI, brief mode, active goal, computer-use tools, twin runtime, and the per-channel A2UI capability prompt converge (incl. the IM computer-use blacklist).
- **A2UI ⇄ IM bridge**: `lib/connectors/a2ui-bridge/*` projects assistant surfaces into platform-native rich content and routes inbound callbacks via `ConnectorBus.dispatchConnectorCallback`. Shared toolkit: `lib/connectors/adapters/_shared/a2ui-mapper.ts`.
- **Static-export caveat**: `app/api/` does not exist in production — anything needing an HTTP server (MCP HTTP, webhook receiver, cron daemon, headless V2 API) lives in Tauri Rust (axum), not Next.js routes.
- **Server-only packages**: vector-DB SDKs + `simple-git` are aliased to `lib/browser-stubs/empty.js` in `next.config.ts`. Add new server-only deps to **both** `SERVER_ONLY_PACKAGES` and `serverExternalPackages`; Node-only built-ins go in `NODE_ONLY_MODULES`. Wrong setup blows up the mobile bundle.

## Testing Standards

- **Coverage**: ≥90% lines/branches/functions; verify with `pnpm test:coverage`
- **Co-located**: `xxx.test.ts(x)` next to source. No `__tests__/` or `tests/` directories
- **Rust**: in-file `#[cfg(test)] mod tests { ... }`; integration tests in `src-tauri/tests/` allowed
- **Excluded from coverage**: `components/ui/` (shadcn) and `components/ai-elements/` (vendored) — don't add tests there
- **Sidecar**: `pnpm sidecar:test` (uses `node --test`, not Jest)

## Commit Hooks

Husky is installed via the root `prepare` script — `pnpm install` once and the hooks are live.

- **`pre-commit`** → `lint-staged` (runs `eslint --fix` + `prettier --write` on staged files)
- **`commit-msg`** → `commitlint` (`@commitlint/config-conventional`) — Conventional Commits enforced

Never bypass with `--no-verify`. If a hook fails, fix the root cause, re-stage, and create a **new** commit (the failed commit was never created).

## Critical Notes

- **pnpm only** — install from repo root
- **Do not remove `output: "export"` in `next.config.ts`** — Tauri and Capacitor builds both consume `out/`. `docs/next.config.ts` is full server; keep separate
- **Native vector store**: sqlite-vec at `<app_data>/cognia/vectors.sqlite`. Web mode hides the native option and forces cloud
- **Rust toolchain**: 1.77.2+
- shadcn/ui: "new-york" style, RSC mode
