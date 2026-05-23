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

Each row has a full ADR under `docs/content/docs/en/adr/` — read it before non-trivial changes.

| Subsystem                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Lives in                                                                                                                                                                                                                                                                                                                                   | Schema                                                                                                  | ADR                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Data backup / transfer** — `BackupPackageV3`, AES-GCM envelopes, per-domain transfers, scheduled backups, history table                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `lib/data/`, `components/settings/data/`, `lib/db/backup-history.ts`                                                                                                                                                                                                                                                                       | —                                                                                                       | 0001                            |
| **Employee Digital Twin** — ingest (7 stages) → distill (5 agents) → runtime RAG + style few-shot; PII redaction is the red-line                                                                                                                                                                                                                                                                                                                                                                                                                                             | `lib/twin/`, `types/twin/`, `components/twin/`, `app/twin/`                                                                                                                                                                                                                                                                                | v14                                                                                                     | 0003                            |
| **External Bridge** — wiki indexer + MCP server (4 tools, 3 resource families); stdio in Phase 1, HTTP via Tauri axum                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `lib/external-bridge/`, `lib/wiki/`, `src-tauri/src/mcp_server/`                                                                                                                                                                                                                                                                           | v17                                                                                                     | 0008                            |
| **Platform Connectors** — Telegram/Discord/Slack/Lark/OneBot; ConnectorBus + outbound runner (quiet-hours, circuit breaker, idempotency, breaker/rate snapshots on heartbeat); A2UI ⇄ IM bridge (capability-aware downgrade, inbound callback channel, computer-use isolation); Lark TAT 401 auto-refresh; callback-binding TTL + daily cleanup; outbound paused/circuit-broken derived badges; audit CSV/JSON export + conv-key filter; inbox header degradation badge + reconnect popover; per-adapter Send Test Message; at-gate 24 h stats                               | `lib/connectors/`, `lib/a2ui/connector-callback-handler.ts`, `app/inbox/`, `components/inbox/`, `src-tauri/src/connectors/`                                                                                                                                                                                                                | v39                                                                                                     | 0009, 0025                      |
| **Unified Subscription Module** — one trait, three providers (Claude PKCE, Codex device-code + discovery, OpenCode discovery + paste-Zen-key); multi-account vaults; per-provider `ProviderPreset` (Anthropic + Codex); encrypted import/export; Anthropic usage tracking stays Anthropic-only                                                                                                                                                                                                                                                                               | `lib/subscription/`, `src-tauri/src/subscription/`, `components/settings/subscription/`                                                                                                                                                                                                                                                    | `com.cognia.subscription/v2` keyring; Dexie `subscriptionUsage` (v20) for Anthropic-only header history | 0025 (supersedes parts of 0010) |
| **Visual Workflows** — React Flow editor; 38 node kinds, 32 executors; hybrid TS + Rust runtime; cron/webhook/connector/chat triggers                                                                                                                                                                                                                                                                                                                                                                                                                                        | `lib/workflow/`, `types/workflow/visual.ts`, `components/workflow/`, `src-tauri/src/workflow/`                                                                                                                                                                                                                                             | v22                                                                                                     | 0011                            |
| **Plugin Dexie Tables** — `<pluginId>:<tableName>` namespace, max 20 tables, idempotent migrations                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `lib/plugin/dexie/`, `lib/plugin/api/dexie-api.ts`                                                                                                                                                                                                                                                                                         | v27                                                                                                     | plugin-dev/dexie-tables.mdx     |
| **GitHub Delivery** — PR review / Issue→PR / Release as workflows; policy-gated + audit-logged                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `lib/github/`, `plugins/github-delivery/`                                                                                                                                                                                                                                                                                                  | —                                                                                                       | 0018                            |
| **Capacitor mobile** — Capacitor 7 shell wrapping `../out`; LAN/tunnel client of headless server (V2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `mobile/`, plus `lib/mobile/`, `lib/api/v1/`                                                                                                                                                                                                                                                                                               | —                                                                                                       | 0014, 0015                      |
| **/goal Command** — self-driving chat loop; 7 exit conditions; PII-redacted judge; `generationId` guard                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `lib/goal/`, `components/goal/`, `lib/slash-commands/actions/goal.ts`                                                                                                                                                                                                                                                                      | v30                                                                                                     | 0019                            |
| **Computer Use** — Anthropic native tools; per-platform automation; 3-tier permission × 4 surfaces; HITL consent overlay                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `src-tauri/src/automation/`, `lib/automation/`, `components/automation/`, `plugins/computer-use/`                                                                                                                                                                                                                                          | v32                                                                                                     | 0020                            |
| **WebRTC WAN transport** — additive third tier between mobile and desktop; separate stateless signaling rendezvous; HMAC end-to-end auth                                                                                                                                                                                                                                                                                                                                                                                                                                     | `signaling-server/`, `lib/signaling/`, `lib/tauri/transport-rtc.ts`, `components/settings/companion/webrtc-card.tsx`                                                                                                                                                                                                                       | v33                                                                                                     | 0021                            |
| **OCR subsystem** — 17 providers (4 cloud-doc, 3 LLM-vision, 4 specialist, Lark, 5 local) behind one `extract()`; platform-aware auto-router; Dexie-backed result cache; PDF text-layer fast-path                                                                                                                                                                                                                                                                                                                                                                            | `lib/ocr/`, `lib/db/ocr-results.ts`, `lib/slash-commands/actions/ocr.ts`, `components/settings/ocr/`, `components/chat/composer/ocr-menu.tsx`, `hooks/use-ocr.ts`, `plugins/ocr/`, `src-tauri/src/ocr/`                                                                                                                                    | v36                                                                                                     | 0024                            |
| **Mobile sync orchestrator** (Wave 4) — 9-table Dexie-first read cache; persistent cursors; network/resume/visibility triggers; `useDexieFirstQuery` hook; `ConnectionStateBadge` dropdown (reconnect/scan/switch); vendored Capacitor mDNS (`capacitor-zeroconf`); Serwist PWA on web+Tauri; companion pause/resume affordance on `pairedDevices` (biometric-guarded)                                                                                                                                                                                                       | `lib/sync/companion-sync.ts`, `lib/sync/cursor-store.ts`, `lib/sync/handlers/`, `hooks/data/use-dexie-first-query.ts`, `lib/connectivity/{mdns-discovery,mdns-permission}.ts`, `lib/capacitor/{app,app-settings}.ts`, `components/mobile/connection-state-badge.tsx`, `components/mobile/connection-state-sheets/`, `app/{sw,manifest}.ts` | v46                                                                                                     | 0027                            |
| **Agent Team** — F-path workflow synthesizer + plugin-first capability model (skills / mcp / native-tools / character-pack / external-preset / subagent / a2ui all hot-swappable per team or per teammate); 13 plugin hook points across the runtime; thin orchestrators for consensus / shared-memory / delegation over the existing store CRUD; `<PresetEditor>` reused for `<TeammateConfigDialog>`; settings tab split into Overview / Plugins / Governance / Memory accordions; `agentTeamTemplates` + `subagents` capabilities ride OVERLAY_REGISTRY (positions 6 + 7) | `lib/ai/agent/`, `lib/ai/agent/team/`, `lib/claude/agents/subagents/`, `lib/plugin/registries/{subagent,agent-team-template}-registry.ts`, `components/agent/workspace/`, `components/settings/presets/editor-sections/`, `stores/agent/agent-team-store/`                                                                                 | v2 (store persist)                                                                                      | 0022, 0032                      |

### Cross-cutting hooks (reuse, don't reinvent)

- **PII redaction**: `lib/twin/ingest/redact.ts:hasNoLeakingPii` is the gate before any LLM/embed call. Twin + Goal share the encrypted master key (`lib/twin/ingest/redaction-key.ts`). Connector auto-mode wraps `sendPrompt` via `lib/connectors/ai-loop/safe-send-prompt.ts` so the same gate fires before every IM-driven turn. Agent Team's `shared-memory-orchestrator.publishEntry` also runs every string value through it before persisting (ADR-0032).
- **Quiet hours**: `lib/connectors/outbound-runner.isInQuietHours` / `msUntilQuietEnd` exported; reused by GitHub Delivery policy gate. v38 rewrote `msUntilQuietEnd` as O(1) (no more 1440-iter minute-step loop).
- **Build-options pipeline**: `lib/claude/build-options.ts:resolveSendOptions` is where A2UI, brief mode, active goal, computer-use tools, twin runtime (opt-in), and the **per-channel A2UI capability prompt** (ADR-0025) all converge. IM sessions also drive the **computer-use IM blacklist** here (off by default; opt-in via `ConversationOverrideRow.allowComputerUse`).
- **A2UI ⇄ IM bridge**: `lib/connectors/a2ui-bridge/*` projects assistant surfaces into platform-native rich content (Slack Block Kit / Lark Interactive Card / Telegram InlineKeyboardMarkup / Discord Embed + Components / OneBot text+image) and routes inbound interactive callbacks back through `ConnectorBus.dispatchConnectorCallback` → `builtin:a2ui-bridge` MCP tool. `lib/connectors/adapters/_shared/a2ui-mapper.ts` is the shared toolkit (walker, action-id generator, callback bindings, plainTextMirror).
- **Static-export caveat**: `app/api/` does not exist in production — anything needing an HTTP server (MCP HTTP, webhook receiver, cron daemon, headless V2 API) lives in Tauri Rust (axum), not Next.js routes.
- **Server-only packages**: vector-DB SDKs (`@pinecone-database/pinecone`, `@qdrant/js-client-rest`, `chromadb`, `@zilliz/milvus2-sdk-node`) plus `simple-git` are aliased to `lib/browser-stubs/empty.js` in `next.config.ts` for both Turbopack and webpack. Add new server-only deps to **both** `SERVER_ONLY_PACKAGES` and `serverExternalPackages`; truly Node-only built-ins go in `NODE_ONLY_MODULES`. Wrong setup blows up the mobile bundle.

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
