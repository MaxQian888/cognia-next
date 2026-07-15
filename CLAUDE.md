# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Next.js 16 (React 19) + Tauri 2.9 + Capacitor 8 + TypeScript + Tailwind v4 + shadcn/ui + Zustand. The same Next.js static export feeds three shells: the browser (`pnpm dev`), the Tauri desktop app (`pnpm tauri dev`), and the Capacitor mobile shell (`pnpm mobile:sync`).

## Working Rules (read before touching code)

These are project-level hard rules. They override any default behavior to the contrary.

> **Development pipeline:** the end-to-end flow that wires these rules to concrete skills/agents/gates (idea → brainstorm → grill → plan → build → preflight → gates) lives in [`WORKFLOW.md`](./WORKFLOW.md). Follow it for any non-trivial change.

1. **Research before implementing.** Before writing any new code, search `lib/`, `components/`, `hooks/`, `src-tauri/`, and the relevant ADR for an existing implementation. Reuse — don't reimplement. If you think you need a new utility/component/hook, first prove (with grep results or file paths) that no equivalent exists. The Subsystem Map and **Cross-cutting hooks** section below list the most reused entry points; check them first.
2. **No simplifications.** Implement the full behavior the task requires. Do not stub, mock-out, abbreviate, or "// TODO later" production paths. Do not strip error handling, validation, or edge cases to ship faster. If something genuinely cannot be implemented now, stop and surface the blocker — do not silently degrade scope.
3. **Every component ships with a unit test.** Any new file under `components/**`, `hooks/**`, `lib/**`, or `src-tauri/src/**` (excluding `components/ui/` and `components/ai-elements/`) must have a co-located `*.test.ts(x)` / in-file `#[cfg(test)]` test. Coverage must stay ≥90% lines/branches/functions; verify with `pnpm test:coverage` before claiming done. Editing an existing component? Update or add tests in the same change.
4. **Every frontend component is i18n-wired.** No hard-coded user-facing strings in `.tsx`. Use `useTranslations()` / `getTranslations()` from `next-intl`, add the new keys to **both** `i18n/messages/en.json` and `i18n/messages/zh-CN.json`, and run `pnpm lint:i18n` to confirm parity with the baseline. Aria labels, placeholders, toasts, and error messages count as user-facing.
5. **Language convention.** Internal narration (status updates, tool-call rationale, end-of-turn summaries, code comments) is written in **English**. Questions to the user — clarifications, `AskUserQuestion` prompts, confirmation requests — are written in **Chinese**.
6. **Record a changeset for every user-facing change.** After implementing a feature, fix, or behavior/breaking change that a user would notice, run `pnpm changeset` — select the **`cognia-next`** package, pick the semver bump (`patch` fix, `minor` feature, `major` breaking), and write a one-line summary. This creates a `.changeset/*.md` file you commit alongside the code. Skip it only for internal-only work (tests, refactors, docs, chore, CI). See **Versioning & Release** below for the full model.

## Development Commands

```bash
# Frontend (port 3000)
pnpm dev / build / start / lint / lint:fix / format / format:check / typecheck

# Jest tests (co-located *.test.ts(x)); two projects: pure-.ts suites under
# lib/stores/cli/packages/types/plugins/i18n run in the fast `node` env,
# everything else (and any `/** @jest-environment jsdom */`-docblocked .ts
# file — required for Dexie/getDb, localStorage, window stubs) runs in jsdom
pnpm test / test:watch / test:coverage
pnpm test:changed            # only suites affected by your diff vs master
pnpm test:coverage:changed   # scoped coverage for changed files only (fast; -- --strict gates at 90%)

# Playwright E2E (tests/e2e/; chromium+mobile run file-parallel, tauri stays serial)
pnpm test:e2e                # against the Turbopack dev server (60s test budget)
pnpm test:e2e:build          # NEXT_PUBLIC_E2E=1 static export → out/
pnpm test:e2e:static         # against the prebuilt out/ (fast, no per-route compiles; run test:e2e:build first)
pnpm test:e2e:changed        # only specs affected by your diff vs master

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

# Storybook (isolated component preview — additive, never replaces Jest)
pnpm storybook        # dev server on :6006
pnpm build-storybook  # static build (catches Vite alias gaps)

# Run a single Jest file
pnpm test -- path/to/file.test.ts
```

**Storybook** (`@storybook/nextjs-vite`, config in `.storybook/`): co-located `*.stories.tsx` for
isolated component dev/preview. Stories are **not tests** — they do not satisfy the co-located-test
rule and are excluded from Jest coverage + `lint:i18n`. The Storybook AI MCP server (`storybook`
entry in `.mcp.json`, `@storybook/addon-mcp`) is only reachable **while `pnpm storybook` is
running** — use its MCP tools to author/preview stories, not as an always-on server.

`predev` / `prebuild` run `scripts/copy-monaco-assets.mjs` automatically — don't import Monaco assets manually.

## Architecture

### Workspaces (`pnpm-workspace.yaml`)

| Package  | Path      | Port | Mode                                                         |
| -------- | --------- | ---- | ------------------------------------------------------------ |
| Main app | `/`       | 3000 | static export (`out/`) — consumed by Tauri **and** Capacitor |
| Docs     | `docs/`   | 3001 | static export (`docs/out/`, Fumadocs) — Cloudflare Pages     |
| Mobile   | `mobile/` | —    | Capacitor 8 shell over `../out`                              |

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

| Subsystem                  | Lives in                                                                                                                                                                                               | Schema                   | ADR              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ---------------- |
| Data backup / transfer     | `lib/data/`, `components/settings/data/`, `lib/db/backup-history.ts`                                                                                                                                   | —                        | 0001             |
| Employee Digital Twin      | `lib/twin/`, `types/twin/`, `components/twin/`, `app/twin/`                                                                                                                                            | v14                      | 0003             |
| External Bridge            | `lib/external-bridge/`, `lib/wiki/`, `src-tauri/src/mcp_server/`                                                                                                                                       | v17                      | 0008             |
| Platform Connectors        | `lib/connectors/`, `lib/a2ui/connector-callback-handler.ts`, `app/inbox/`, `components/inbox/`, `src-tauri/src/connectors/`                                                                            | v39                      | 0009, 0025, 0036 |
| Unified Subscription       | `lib/subscription/`, `src-tauri/src/subscription/`, `components/settings/subscription/`                                                                                                                | keyring v2 / v20         | 0025             |
| Visual Workflows           | `lib/workflow/`, `types/workflow/visual.ts`, `components/workflow/`, `src-tauri/src/workflow/`                                                                                                         | v22                      | 0011             |
| Plugin Dexie Tables        | `lib/plugin/dexie/`, `lib/plugin/api/dexie-api.ts`                                                                                                                                                     | v27                      | dexie-tables.mdx |
| GitHub Delivery            | `lib/github/`, `plugins/github-delivery/`                                                                                                                                                              | —                        | 0018             |
| Capacitor mobile           | `mobile/`, `lib/mobile/`, `lib/api/v1/`                                                                                                                                                                | —                        | 0014, 0015       |
| /goal Command              | `lib/goal/`, `components/goal/`, `lib/slash-commands/actions/goal.ts`                                                                                                                                  | v30                      | 0019             |
| Computer Use               | `src-tauri/src/automation/`, `lib/automation/`, `components/automation/`, `plugins/computer-use/`                                                                                                      | v32                      | 0020             |
| WebRTC WAN transport       | `services/signaling-server/`, `lib/signaling/`, `lib/tauri/transport-rtc.ts`, `components/settings/companion/webrtc-card.tsx`                                                                          | v33                      | 0021             |
| OCR subsystem              | `lib/ocr/`, `lib/db/ocr-results.ts`, `lib/slash-commands/actions/ocr.ts`, `components/settings/ocr/`, `hooks/use-ocr.ts`, `plugins/ocr/`, `src-tauri/src/ocr/`                                         | v36                      | 0024             |
| Mobile sync orchestrator   | `lib/sync/`, `hooks/data/use-dexie-first-query.ts`, `lib/connectivity/`, `lib/capacitor/`, `components/mobile/`, `app/{sw,manifest}.ts`                                                                | v46                      | 0027             |
| Agent Team                 | `lib/ai/agent/`, `lib/claude/agents/subagents/`, `lib/plugin/registries/`, `components/agent/workspace/`, `stores/agent/agent-team-store/`                                                             | v4 persist               | 0002, 0022, 0032 |
| Integrated terminal        | `lib/terminal/`, `components/terminal/`, `stores/terminal/`, `src-tauri/src/terminal/`, `src-tauri/src/companion_api/ws_terminal.rs`                                                                   | persist                  | 0031, 0033       |
| Rust performance dashboard | `src-tauri/src/perf/`, `lib/perf/backend/`, `hooks/perf/use-perf-stream.ts`, `components/performance/`, `app/performance/`                                                                             | —                        | 0035             |
| Public share links         | `lib/share/`, `lib/db/shared-links.ts`, `components/share/`, `app/share/view/`, `services/share-server/worker/`, `services/share-server/pages/`                                                        | v54                      | 0037             |
| Desktop pet                | `components/pet/`, `lib/pet/`, `hooks/pet/`, `stores/pet/`, `types/pet/`, `src-tauri/src/pet_window/`                                                                                                  | Dexie (no schema bump)   | 0058             |
| Web reader                 | `lib/web/reader/`, `lib/web/web-tools-core.ts`, `packages/document/.../html-parser.ts`, `lib/twin/ingest/url-fetcher.ts`                                                                               | —                        | 0060             |
| Wiki lint                  | `lib/wiki/lint/`, `lib/db/wiki-lint-results.ts`, `components/settings/external-bridge/wiki-lint-card.tsx`                                                                                              | Dexie v95                | 0060             |
| Attention Radar            | `lib/radar/`, `types/radar/`, `lib/db/radar-reports.ts`, `components/pet/console/radar-panel.tsx`, `hooks/pet/use-pet-insight.ts`                                                                      | Dexie v96                | 0060             |
| Content capture            | `lib/capture/`, `types/capture/`, `components/capture/`, `stores/capture/`, `hooks/capture/`, `lib/db/captured-items.ts`, `src-tauri/src/capture/`                                                     | Dexie v97                | 0060             |
| Agent session import       | `lib/session-import/`, `hooks/session-import/`, `components/session-import/`, `src-tauri/src/session_import.rs`, `lib/plugin/api/import-api.ts`                                                        | reuses sessions/messages | 0062             |
| Optical compaction         | `sidecar/dispatch/optical/`, `sidecar/dispatch/compaction*.mjs`, `lib/db/optical-archives.ts`, `lib/claude/optical-archive-persist.ts`, `components/chat/message-parts/optical-archive-dialog.tsx`     | Dexie v101               | 0063             |
| Long-term memory           | `lib/memory/` (`api/` = shared external surface), `types/memory/`, `lib/db/memories.ts`, `components/memory/`, `app/memory/`, `lib/plugin/api/memory-api.ts`, `lib/external-bridge/handlers/memory.ts` | Dexie v65                | 0069             |
| Risk→ceremony policy       | `lib/policy/risk/`, `lib/ai/agent/team/risk-input.ts`, gate wiring in `lib/ai/agent/agent-team-runtime.ts`                                                                                             | —                        | 0070             |

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

## Versioning & Release (Changesets)

The app is versioned as **one unit**: the root `package.json` `version` is the single source of truth, and [Changesets](https://github.com/changesets/changesets) manages both the version bump and `CHANGELOG.md`.

- **During development** — for any user-facing change, run `pnpm changeset` and select the **`cognia-next`** package (Working Rule 6). Each run writes a `.changeset/*.md` entry that you commit with the code; they accumulate until the next release.
- **At release time** — run `pnpm release:version`. This runs `changeset version` (consumes the pending `.changeset/*.md`, bumps the root version, prepends the aggregated entries to `CHANGELOG.md`) and then `pnpm version:sync`, which propagates the new version to every app artifact (`src-tauri/tauri.conf.json`, the three `Cargo.toml`s, `cli/`, `sidecar/`, `sidecar/vscode-ext-host/`, `mobile/`, `docs/`). Commit the result and tag it.
- **Scope** — only the root `cognia-next` is Changesets-managed. `docs`, `mobile`, and every `@cognia/*` workspace package are in `ignore` (`.changeset/config.json`) and never versioned or published this way. The root is listed in `pnpm-workspace.yaml` **only** so Changesets can see it; pnpm still excludes it from recursive commands by default.
- **No CI/publish step** — the flow is local-only and does not publish to npm; `access` is `restricted`. Do not add a `changeset publish` step or a release GitHub Action without confirming with the user first.
- `pnpm changeset:status` shows what would be released.

## Critical Notes

- **pnpm only** — install from repo root
- **Do not remove `output: "export"` in `next.config.ts`** — Tauri and Capacitor builds both consume `out/`. `docs/next.config.ts` is also a static export (`docs/out/`); keep the two configs separate
- **Native vector store**: sqlite-vec at `<app_data>/cognia/vectors.sqlite`. Web mode hides the native option and forces cloud
- **Rust toolchain**: 1.77.2+
- shadcn/ui: "new-york" style, RSC mode
