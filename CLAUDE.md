# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

React + Tauri desktop application starter: Next.js 16 (React 19) + Tauri 2.9 + TypeScript + Tailwind CSS v4 + shadcn/ui + Zustand.

**Dual Runtime Model:**

- **Web mode** (`pnpm dev`): Next.js dev server at <http://localhost:3000>
- **Desktop mode** (`pnpm tauri dev`): Tauri wraps Next.js in a native window

## Development Commands

```bash
# Frontend (main app — port 3000)
pnpm dev              # Start Next.js dev server
pnpm build            # Build for production (outputs to out/)
pnpm lint             # Run ESLint
pnpm lint:fix         # Auto-fix ESLint issues
pnpm format           # Format with Prettier
pnpm format:check     # Check formatting without writing
pnpm typecheck        # TypeScript --noEmit

# Testing
pnpm test             # Run Jest tests
pnpm test:watch       # Run tests in watch mode
pnpm test:coverage    # Run tests with coverage report

# Desktop (Tauri)
pnpm tauri dev        # Dev mode with hot reload
pnpm tauri build      # Build desktop installer
pnpm tauri info       # Check Tauri environment

# Docs site (pnpm workspace — port 3001)
pnpm docs:dev         # Start Fumadocs dev server
pnpm docs:build       # Build docs for production
pnpm docs:start       # Start docs production server

# Add shadcn/ui components
pnpm dlx shadcn@latest add <component-name>
```

## Architecture

### Workspace Structure

This is a **pnpm monorepo** with two packages:

| Package  | Path       | Port | Purpose                                          |
| -------- | ---------- | ---- | ------------------------------------------------ |
| Main app | `/` (root) | 3000 | Next.js + Tauri desktop app (`output: "export"`) |
| Docs     | `docs/`    | 3001 | Fumadocs documentation site (full server mode)   |

Root `pnpm-lock.yaml` is the single lockfile for all packages. Run `pnpm install` from the repo root.

### Frontend Structure (main app)

- `app/` - Next.js App Router (layout.tsx, page.tsx, globals.css)
- `components/ui/` - All 57 shadcn/ui components pre-installed (**no test files here**)
- `hooks/` - Shared hooks (e.g., `use-mobile.ts`)
- `lib/utils.ts` - `cn()` utility (clsx + tailwind-merge)

### Docs Structure (`docs/`)

- `docs/app/` - Next.js App Router for the docs site
  - `docs/app/layout.tsx` - Root layout with `RootProvider` (from `fumadocs-ui/provider/next`)
  - `docs/app/docs/layout.tsx` - `DocsLayout` with sidebar
  - `docs/app/docs/[[...slug]]/page.tsx` - Dynamic MDX page
  - `docs/app/api/search/route.ts` - Orama full-text search
- `docs/lib/source.ts` - Fumadocs loader (imports from `collections/server`)
- `docs/source.config.ts` - Content collection definition
- `docs/content/docs/` - MDX content files and `meta.json` sidebar config
- `docs/.source/` - **Auto-generated** by fumadocs-mdx at dev/build time (gitignored)

**Docs-specific import conventions:**

- Source loader: `import { source } from "@/lib/source"` (NOT `@/app/source`)
- Collection output: `import { docs } from "collections/server"` (tsconfig alias → `.source/`)
- Provider: `fumadocs-ui/provider/next` (NOT `fumadocs-ui/provider`)

### Installed shadcn/ui Components

All components are pre-installed — import directly, do not run `shadcn add` for these:

`accordion` · `alert` · `alert-dialog` · `aspect-ratio` · `avatar` · `badge` · `breadcrumb` · `button` · `button-group` · `calendar` · `card` · `carousel` · `chart` · `checkbox` · `collapsible` · `combobox` · `command` · `context-menu` · `dialog` · `direction` · `drawer` · `dropdown-menu` · `empty` · `field` · `form` · `hover-card` · `input` · `input-group` · `input-otp` · `item` · `kbd` · `label` · `menubar` · `native-select` · `navigation-menu` · `pagination` · `popover` · `progress` · `radio-group` · `resizable` · `scroll-area` · `select` · `separator` · `sheet` · `sidebar` · `skeleton` · `slider` · `sonner` · `spinner` · `switch` · `table` · `tabs` · `textarea` · `toggle` · `toggle-group` · `tooltip`

`TooltipProvider` is already mounted in `app/layout.tsx` — no extra wrapper needed.

### Tauri Integration

- `src-tauri/` - Rust backend
  - `tauri.conf.json` - Config pointing `frontendDist` to `../out`
  - `beforeDevCommand`: runs `pnpm dev`
  - `beforeBuildCommand`: runs `pnpm build`

### Styling System

- **Tailwind v4** via PostCSS (`@tailwindcss/postcss`)
- CSS variables for theme colors (oklch color space) in `globals.css`
- Dark mode: class-based (apply `.dark` to parent element)
- Custom variant: `@custom-variant dark (&:is(.dark *))`

### Path Aliases

`@/components`, `@/lib`, `@/utils`, `@/ui`, `@/hooks` - all configured in tsconfig.json and components.json

## Code Patterns

```tsx
// Always use cn() for conditional classes
import { cn } from "@/lib/utils"
cn("base-classes", condition && "conditional", className)

// Button composition with asChild
<Button asChild>
  <Link href="/path">Click me</Link>
</Button>
```

```tsx
// Calling Rust from the frontend (Tauri only) — see lib/tauri.ts
import { greet, isTauri } from "@/lib/tauri"
if (isTauri()) {
  greet("World").then((msg) => console.log(msg))
}
```

## Data Backup & Transfer

cognia-next ships a full-featured backup/import system under `lib/data/`. The
schema is **v3** (`BackupPackageV3` in `lib/data/types.ts`). v1 files import
through the `migrateEnvelope` boundary so legacy users keep working.

- **Build a snapshot**: `buildBackupPackage({ includeSessions, includeApiKey })`
  → returns `BackupPackageV3` with a `manifest.integrity` SHA-256 checksum.
- **Encrypt**: `encryptBackupPackage(plaintext, passphrase, manifest)` →
  `EncryptedEnvelopeV1` (AES-GCM, PBKDF2-SHA256-600000).
- **Migrate-on-import**: `migrateEnvelope(parsed)` accepts v1, v3, or
  encrypted; throws `IsEncryptedError` for the latter so the caller can
  prompt for a passphrase.
- **Apply**: `applyBackupPackage(pkg, opts)` writes the payload to Dexie
  under one of three merge strategies (skip / overwrite / duplicate),
  preserving built-in characters/skills/teams.
- **Per-domain transfers**: `lib/data/domain/index.ts` exports `DOMAIN_TRANSFERS`
  - `buildDomainExport(key)` / `applyDomainImport(file, strategy)` for each of
    skills, MCP servers, prompt presets, characters, teams, and theme.
- **External imports**: `lib/data/import-registry.ts` dispatches to
  `chatgpt-import.ts` / `claude-import.ts` / `gemini-import.ts`.
- **Scheduled backups**: `BackupSchedulerProvider` mounted in `app/layout.tsx`
  drives an auto-key encrypted write every `intervalDays` to the user's
  configured folder (Tauri only). Web users see the reminder banner.
- **History**: `lib/db/backup-history.ts` records every success/failure to
  the `backupHistory` Dexie table (capped at 50 newest, indexed by completedAt).
- **Settings tabs**: `components/settings/data/data-section.tsx` is a tabbed
  shell — Overview / Backup & restore / Domain transfer / Maintenance, with
  the active tab reflected in `?dataTab=` on the URL.
- **Chat-header trigger**: every chat shows a `SingleExportTrigger`
  (`components/chat/dialogs/single-export-trigger.tsx`) that opens a
  per-session export dialog (Markdown / JSON / Plain text / Beautiful HTML
  / Animated HTML, with theme + custom-theme editor for the HTML formats).

See `docs/content/docs/adr/0001-backup-schema-v3.md` for the full ADR.

## Employee Digital Twin

cognia-next can distil a person's documents, chat exports, and code into
a chat-ready "twin" that runs RAG + style few-shot at send time. The
subsystem lives entirely under `lib/twin/`, `types/twin/`, and
`components/twin/`, with five Dexie tables added at schema v14
(`twinSources` / `twinChunks` / `twinProfile` / `twinDrafts` /
`twinJobs`).

- **Ingest pipeline** (`lib/twin/ingest/`): seven stages — `dispatch` →
  `parse` (via `lib/document/document-processor`) → `redact` (PII
  scrubbed before any cloud call) → `chunk` (format-aware strategy:
  heading for markdown, code for source, paragraph for chat) →
  `embed` (`lib/ai/embedding/embedding`) → `persist` (Dexie + remote
  vector store double-write) → `finalize`. The `runIngestJob`
  orchestrator updates `TwinJob.phase` + `progress` for the workbench.
- **Distill pipeline** (`lib/twin/distill/`): five sub-agents under one
  orchestrator — `KnowledgeAgent` (entity extraction, batched 100
  chunks per call), `StyleAgent` (representative writing samples),
  `PlaybookAgent` (repeated work patterns w/ confidence floor),
  `Synthesizer` (Character + Skill drafts), `Evaluator`
  (newcomer-perspective qualityScore + concerns + suggestions). All
  agents go through the `LlmClient` interface in
  `lib/twin/distill/llm.ts`; tests use mocks, production wires
  `createAnthropicLlmClient`.
- **Runtime** (`lib/twin/runtime/`): `applyTwinContext` is the single
  entry point. It embeds the user message once, runs RAG via the
  remote vector store, picks top-K style few-shot from the profile,
  and assembles a four-segment system prompt (character prompt →
  identity block → retrieved chunks → style examples). Always returns
  — never throws — so a vector-store outage degrades to a no-context
  send rather than breaking the chat. **Phase 8 leaves the
  `lib/claude/build-options.ts:resolveSendOptions` integration as
  opt-in;** call sites that want the runtime injection do so
  explicitly.
- **Workbench UI** (`app/twin/`, `components/twin/`): four tabs —
  Sources (paste + format picker + status badges), Jobs (live progress
  - queue ingest / queue distill), Drafts (pending-first sort, accept
    flow writes a real `Character` / `Skill` row + stamps the draft as
    accepted), and Settings (read-only profile stats).
- **Job worker** (`lib/twin/job-worker.ts`): drains the `twinJobs` queue
  for both `ingest` and `distill` jobs. Phase 4 ships immediate-execute
  semantics; cron-driven retries via the scheduler executor are a
  later add.
- **Soft binding**: a "twin" is a string id; characters opt in via
  `Character.twinId` and tune via `Character.twinSettings`
  (`enableRag`, `ragTopK`, `enableStyleFewShot`, `styleSamplesK`).
  Multiple characters can share a twin; multiple twins can co-exist
  in one Dexie database.
- **Privacy**: PII (emails, phone numbers, CN national IDs, Luhn-valid
  bank cards, hint-driven names) is replaced with
  `<KIND_NNN>` placeholders before any embed / LLM call. The
  redaction map is encrypted on disk (`twinSources.redactionMapEnc`).
  `lib/twin/ingest/redact.ts:hasNoLeakingPii` is the red-line check.

See `docs/content/docs/adr/0003-employee-digital-twin.md` for the full ADR.

## External Bridge (LLM Wiki + MCP server)

cognia-next exposes its own knowledge — generated code wikis, RAG over
those wikis, and runtime entities (skills/characters/twins/plugins/
agent-teams) — to external coding agents (Claude Code, Cursor, Cline,
Codex) via a Model Context Protocol (MCP) server. The bridge lives
under `lib/external-bridge/` + `lib/wiki/` and is fully OptIn — every
scope defaults to OFF except the public-code wiki + RAG.

- **Schema (v17)**: 4 new Dexie tables —
  - `wikiArticles` (slug-keyed, scope-filtered, page-rank-sorted)
  - `wikiSections` (split out for partial reload + rag_search)
  - `wikiManifest` (per-scope Merkle map + build metadata)
  - `mcpAuditLog` (capped 5000 newest)
- **Wiki indexer** (`lib/wiki/orchestrator.ts:rebuildWiki`): walks
  `lib/`/`app`/`components`/`hooks`/`types`, hashes files, diffs vs the
  manifest, then drives 4 sub-agents — `RepoMapAgent` (size-heuristic
  pageRank; full PageRank deferred to Phase 2), `ModuleArticleAgent`
  (one LLM call per module), `CrossRefAgent` (rewrites backtick paths
  to `[[slug]]` links), `IndexPageAgent` (top-level index page).
  Reuses `lib/twin/ingest/chunk.ts:prepareChunks` (code chunker) and
  `lib/twin/distill/llm.ts:LlmClient`.
- **MCP server** (`lib/external-bridge/mcp-server/`): 4 tools
  (`wiki_search`, `wiki_read`, `rag_search`, `runtime_query`) + 3
  resource families (`cognia://wiki/<slug>`, `cognia://skill/<id>`,
  `cognia://character/<id>`). Built on `@modelcontextprotocol/sdk` v1.29.
  `standalone-entry.ts` is the node CLI entry that the Tauri sidecar
  spawns; the Phase 2 plugin packaging will reuse it as the bundled
  binary.
- **Permission gate** (`lib/external-bridge/permission-gate.ts`): every
  call goes through `checkScope` against `AppSettings.externalBridge.
enabledScopes` before the handler runs. Denials get MCP error
  envelopes; every call (allowed or denied) writes to `mcpAuditLog`
  via `audit-log.ts`.
- **HTTP transport (R1 decision)**: HTTP MCP server runs in **Tauri
  Rust (axum/hyper)** under `src-tauri/src/mcp_server/`, NOT as a
  Next.js `app/api/mcp` route — `output: "export"` precludes API
  routes. Phase 1 ships stdio only; HTTP lands when the Rust path is
  wired (M3 in the plan).
- **Markdown export** (`lib/wiki/exporter.ts`): write `wikiArticles` to
  `docs/content/docs/wiki/<scope>/<slug>.mdx` plus an `index.mdx`.
  Exporter is fs-abstract via the `WriteFs` interface so the Tauri
  plugin-fs path and the test in-memory map share one code path.
- **Settings UI**:
  `components/settings/external-bridge/external-bridge-section.tsx`
  is a tab under Settings → System (`?section=external-bridge`).
  Renders 4 cards — server status + token, scope toggles (9 scopes),
  setup snippet (stdio / HTTP), audit log table.

See `docs/content/docs/adr/0008-external-bridge.md` for the full ADR.

## Claude Subscription OAuth

cognia-next supports Claude Pro/Max OAuth login alongside the legacy
API-key path, with live 5-hour / 7-day rate-limit visibility built on
the `anthropic-ratelimit-unified-*` response headers. The subsystem
lives under `lib/anthropic-subscription/`, `components/settings/
subscription/`, and `src-tauri/src/anthropic_subscription/`.

- **OAuth flow**: paste-the-code PKCE against `claude.ai/oauth/authorize`
  (subscription mode) or `console.anthropic.com/oauth/authorize`
  (console mode). Both share the public Claude Code client_id
  `9d1c250a-...`; the differentiator is the authorize host + redirect
  URI + scopes. Token endpoint is `POST https://platform.claude.com/v1/
oauth/token` (form-encoded — JSON returns 400 invalid_grant).
- **Credential storage**: OS keyring via the `keyring` crate, service
  `com.cognia.claude-subscription/v1`, account `default`. Tauri-only;
  the web build degrades to a banner. cognia-next never writes
  `~/.claude/.credentials.json` — that file is owned by `claude login`.
- **Sidecar integration** (`src-tauri/src/api_key.rs:set_oauth_bearer`,
  `src-tauri/src/claude/sidecar.rs:spawn`): when an OAuth bearer is
  registered, the sidecar is spawned with `CLAUDE_CODE_OAUTH_TOKEN`
  set (and `ANTHROPIC_API_KEY` actively unset). The official
  `@anthropic-ai/claude-agent-sdk` reads this var and sends Bearer
  auth + the `oauth-2025-04-20` beta header automatically — we don't
  need a custom fetch wrapper for the agent path.
- **Passive usage collection**: `sidecar/fetch-interceptor.mjs`
  monkey-patches `globalThis.fetch` _before_ the agent SDK loads.
  Every response on `api.anthropic.com` triggers a `usage_headers`
  stdout event; `lib/anthropic-subscription/usage-collector.ts`
  parses + persists to the `subscriptionUsage` Dexie table (v20).
  Zero extra quota cost — every real chat send doubles as a sample.
- **Active probe** (`lib/anthropic-subscription/usage-probe.ts`):
  default-OFF opt-in. Sends a near-empty `POST /v1/messages` and
  reads the unified-\* headers. Each probe consumes ~10 input + 1
  output tokens (no documented Anthropic carve-out — surface this
  in UI). Cadence floor 60 s.
- **UI** (`components/settings/subscription/subscription-section.tsx`):
  4 tabs at `?subTab=overview|account|usage|settings` — status badge +
  5h/7d progress bars with reset countdowns; account email/plan/expiry
  - manual refresh + sign out; recent-200-samples table; cadence +
    threshold settings. Mounted in the sidebar between Providers and
    CCSwitch.

See `docs/content/docs/adr/0010-claude-subscription-oauth.md` for the
full ADR.

## Platform Connectors

cognia-next AI characters can act as real bots on Telegram, Discord, Slack,
Lark (Feishu), and QQ/NapCat (OneBot v11). The subsystem lives under
`lib/connectors/`, `types/connectors/`, `components/settings/connections/`,
`components/inbox/`, and `app/inbox/`, with Rust transport helpers under
`src-tauri/src/connectors/`.

- **Schema (v18)**: 8 new Dexie tables —
  `adapterInstances` / `platformIdentities` / `inboundLedger` /
  `outboundQueue` / `conversationOverrides` / `connectorAudit` /
  `connectorDrafts` / `connectorAttachments`.
- **ConnectorBus** (`lib/connectors/bus.ts`): singleton fan-in / fan-out.
  `getBus()` → `registerAdapter()` / `unregisterAdapter()`.
  Each adapter calls `bus.inbound()` on arrival; the bus evaluates the
  `TriggerPolicy`, routes to the mode handler, and persists to `connectorAudit`.
- **Five built-in adapters** (`lib/connectors/adapters/`):
  `telegram/` (long-poll or webhook), `discord/` (Gateway WS v10),
  `slack/` (Events API webhook), `lark/` (event callback webhook),
  `onebot/` (reverse-WS). Each folder contains
  `parse.ts` / `serialize.ts` / transport / `capability.ts` / `sigverify.ts` / `index.ts`.
- **Outbound queue runner** (`lib/connectors/outbound-runner.ts`):
  Dexie-backed FIFO per conversation with circuit breaker (50% failure rate /
  10-event window / 30 s cooldown), token bucket (cap 20 / 5 tok·s⁻¹),
  exponential back-off (`min(60 s, 1 s × 2ⁿ) + jitter`), dead-letter at 5
  attempts, idempotency LRU (1 000 entries), and quiet-hours / muted guard.
  `isInQuietHours(nowMs, from, to, tz)` and `msUntilQuietEnd(nowMs, to, tz)`
  are exported for reuse.
- **Mode routing**: three layers — adapter default → per-conversation override
  → event override. Modes: `auto` (AI reply, Phase 1 stubbed), `manual` (human
  types in Composer), `draft` (AI generates; human approves via Inbox).
- **Scheduler integration** (`lib/connectors/scheduled-outbound.ts`):
  `installScheduledOutboundHandlers()` registers executors for
  `"connection:outbound:send"` and `"connection:scheduled:digest"`.
- **Plugin extension API** (`lib/plugin/connectors-bridge.ts`):
  `registerPluginAdapters(pluginId, manifest, exports)` discovers
  `manifest.connectors[]` and calls each factory. `unregisterPluginAdapters`
  cleans up on plugin disable. The `PluginConnectorDef` type lives in
  `types/plugin/plugin.ts`.
- **Settings UI** (`components/settings/connections/connections-section.tsx`):
  tabbed shell at `?section=connections`. Tabs: Overview / Adapters /
  Conversations / Inbox / Outbound / Audit. Quiet-hours + mute form lives in
  `components/settings/connections/forms/quiet-hours-and-mute.tsx`.
- **Web-mode degradation**: in browser (non-Tauri) the connections banner
  (`role="status" aria-label="Web mode banner"`) explains the limitation; the
  mode switcher in `ConversationHeader` gets `pointer-events-none`; the
  Composer Send button is disabled for platform-bound sessions.
- **Inbox UI** (`app/inbox/`, `components/inbox/`): `InboxShell` +
  `InboxSidebar` (data-testid `"inbox-sidebar"`) list platform-bound sessions.
  `/inbox/[conversationKey]` is a client-only static page compatible with
  `output: "export"`.
- **E2E tests**: `playwright.config.ts` + `tests/e2e/connectors/` contain a
  Playwright suite with an Express-based mock Telegram server
  (`createTelegramMockServer`). Install deps first:
  `pnpm add -D express @types/express @playwright/test && pnpx playwright install chromium`.

See `docs/content/docs/adr/0009-platform-connectors.md` for the full ADR.

## Visual Workflows

cognia-next ships an n8n-style visual orchestration layer that lets users
wire characters, teams, skills, twins, connectors, and AI primitives into
executable graphs with a durable run history. The subsystem lives entirely
under `lib/workflow/`, `types/workflow/visual.ts`, `components/workflow/`,
and `components/settings/workflows/`, with four Dexie tables added at
schema **v22** (`workflows` / `workflowRuns` / `workflowRunEvents` /
`workflowTriggers`).

- **Type model** (`types/workflow/visual.ts`): namespaced separately from
  the existing PPT-focused `./workflow.ts` so the two families coexist —
  the visual graph's top-level shape is exported as `VisualWorkflow` (NOT
  `WorkflowDefinition`). 38 node kinds across 7 categories
  (`trigger.* / action.* / ai.* / flow.* / data.* / io.* / annotation.*`).
- **Editor** (`components/workflow/editor/`, `lib/workflow/editor/`):
  React Flow v12 + Zustand+zundo store + elkjs auto-layout. Single-renderer
  `WorkflowNodeComponent` covers every kind with category-colored cards.
  Left-rail `NodeSearchSidebar` (drag-from-sidebar via custom MIME), right-
  rail `InspectorPanel` (per-kind config form pulled from a registry),
  toolbar with Save / Run / Undo / Redo / Auto-layout. Ctrl+S / Ctrl+Z /
  Ctrl+Shift+Z keyboard shortcuts.
- **Per-kind inspector forms** (`components/workflow/editor/inspector/forms/`):
  18 dedicated forms (cron, character/team/skill pickers, AI prompt with
  full provider routing, branch, set, wait, HTTP, code, template,
  transform, note, generic-JSON fallback). Drives node `params`.
- **Runtime engine** (`lib/workflow/runtime/`): six modules — orchestrator,
  step-executor, event-log, idempotency cache, expression resolver, topo-sort.
  Inngest-style memoization by `(runId, stepId)` so resumed runs replay
  nothing. Retries respect per-workflow policy with exponential / fixed
  backoff. Timeout via `AbortController`. Branch decisions skip non-chosen
  edges via `propagateSkip`. Workflow snapshots are frozen at run start —
  re-runs from history use the snapshot, not the live workflow.
- **Node executor registry** (`lib/workflow/nodes/registry.ts`): plugins can
  register new executors via `registerNodeExecutor`. Phase 1 ships 14 real
  executors (manual, set, branch, switch, split, join, loop, wait, transform,
  template, code, http, skill.invoke, real-or-stub ai.prompt). Remaining
  kinds land as their TS subsystem integrations are wired.
- **Trigger taxonomy**: manual (Run button), cron (existing TS scheduler;
  Rust daemon for "fires when minimized" is Phase 5a), connector inbound
  (ConnectorBus tap; Phase 5b), chat message (build-options hook; Phase 5b),
  webhook (Rust axum; Phase 5a, Tauri-only — web shows "desktop only").
- **Hybrid runtime split** (Phase 5a/b — Rust pieces pending): Rust owns
  cron firing + webhook receive + connector inbound tap + run-state mirror
  in SQLite for crash recovery. TS owns orchestration + node execution +
  Dexie definition / event-log storage. Crossing happens only at
  `workflow:trigger` / `workflow:resume` Tauri events and the IPC commands
  in `lib/workflow/runtime/tauri-bridge.ts` (web mode no-ops gracefully).
- **Run history** (`components/workflow/runs/`): Gantt-style horizontal
  timeline at `/workflows/[id]/runs/[runId]` builds spans from the durable
  event log via `buildSpans`; collapses retries into a single bar with an
  attempt counter; per-step inspector surfaces resolved params, output,
  error, and structured logs. Re-run-from-snapshot button re-invokes the
  orchestrator with the same snapshot.
- **Settings UI** (`components/settings/workflows/`): tab under Settings →
  Data (`?section=workflows`). 5-tab shell — Library / Runs / Templates /
  Defaults / Audit (`?wfTab=…`). The Library tab embeds the same
  `<WorkflowLibrary />` rendered at `/workflows` so users can manage from
  Settings without leaving the shell.
- **Built-in templates** (`lib/workflow/definition/seed.ts`): 4 templates
  ship in Phase 1 — Hello world, HTTP→transform→summarize, Classify then
  branch, Skills + AI. All compose only registered executors so they run
  out of the box.
- **Web-mode degradation**: when `!isTauri()`, cron triggers fire only
  while the webview is alive; webhook triggers show "desktop only";
  manual / chat-message / connector triggers (TS-side) work unchanged.
  Library, editor, run history, and templates UI all work fully.

See `docs/content/docs/adr/0011-workflows-subsystem.md` for the full ADR.

## Testing Standards

- **Coverage requirement**: every source file must reach **≥90% test coverage** (lines, branches, functions). Verify with `pnpm test:coverage`.
- **TypeScript / TSX tests**: co-locate next to the source file as `xxx.test.ts` or `xxx.test.tsx` (e.g., `lib/avatar.ts` → `lib/avatar.test.ts`, `components/chat/message.tsx` → `components/chat/message.test.tsx`). Do **not** use a separate `__tests__/` or `tests/` directory.
- **Rust tests**: write inside the same `.rs` file in a `#[cfg(test)] mod tests { ... }` block. Do not create separate test files for unit tests (integration tests in `src-tauri/tests/` are still allowed).
- **Exceptions** (no tests, exclude from coverage thresholds):
  - `components/ui/` — vendored shadcn/ui
  - `components/ai-elements/` — vendored ai-elements components

## Critical Notes

- **Always use pnpm** (lockfile present); run `pnpm install` from repo root to install all workspaces
- **Tauri production builds require static export**: `next.config.ts` (main app) has `output: "export"` — do not remove it
- **Native vector store is sqlite-vec backed**: data lives at `<app_data>/cognia/vectors.sqlite`. Web mode forces a cloud backend (the native option is hidden in the Twin settings tab when `!isTauri()`).
- **Docs does NOT use static export**: `docs/next.config.ts` is full server mode — keep them separate
- **Rust toolchain**: Requires v1.77.2+ for Tauri builds
- **Docs `.source/` is generated**: run `pnpm docs:dev` or `pnpm docs:build` once before TypeScript resolves `collections/server`
- shadcn/ui configured with "new-york" style and RSC mode
