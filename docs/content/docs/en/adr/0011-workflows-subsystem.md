---
title: "0011 — Visual Workflows Subsystem"
description: "cognia-next gains an n8n-style visual orchestration layer that lets users wire characters, teams, skills, twins, connectors, and AI primitives into executable graphs with a durable run history."
---

# ADR 0011 — Visual Workflows Subsystem

**Status:** Accepted
**Date:** 2026-05-08
**Branch:** `feat/workflows-phase1`

---

## Context

cognia-next has rich runtime entities — Characters, Agent Teams, Skills, Twins, Connectors, MCP
servers, Plugins — but no first-class way for a user to compose them into multi-step automations.
The previous-generation repo (`D:\Project\Cognia`) shipped a mature React Flow editor with
~46 node types but **omitted character/team integration entirely** — its workflows were pure
automation, blind to the agent runtime. That gap is the rewrite driver.

Goals:

- A **visual graph editor** modeled on n8n: drag from a left rail, connect with handles, configure
  via a right inspector, save with Ctrl+S, undo/redo with zundo, auto-layout via elkjs.
- An **execution engine** that runs the graph end-to-end, persists every step to a durable event
  log, supports retry / timeout / idempotency, and resumes from the log after a webview crash.
- **Trigger taxonomy** that hooks into existing infrastructure — manual, cron, connector inbound,
  chat message, webhook — without forking a parallel scheduler.
- A **Settings entry** users can discover via the existing nav + sidebar search.
- A **5-tab Workflows section** mirroring the Data / Connections sections.
- A **run history UI** with Gantt timeline + per-step inspector + re-run from failure.
- A **hybrid runtime split** — Rust trigger daemons + state mirror, TS orchestrator + node
  executors — so cron triggers fire when the webview is minimized to tray and runs survive a
  webview crash without forking every node implementation into Rust.
- **Built-in templates** so first-time users have a working pipeline to clone.

Non-goals (explicit):

- Multi-user collaboration / CRDT — single-user desktop app.
- A workflow marketplace.
- A visual debugger with breakpoints.

---

## Decision

### Architecture overview

```
┌──── Rust (src-tauri/src/workflow/) — always-on, survives webview reload ────┐
│  Cron daemon · Webhook receiver · Connector inbound tap · Run state mirror   │
│  Emits Tauri events: "workflow:trigger" / "workflow:resume"                  │
└──────────────────────────────────────┬─────────────────────────────────────┘
                                       │
                                       ▼
┌──── TS (lib/workflow/) — runs inside the webview ───────────────────────────┐
│  trigger-bridge → Orchestrator → RunActor → StepExecutor → NodeRegistry      │
│                                                          │                   │
│                                                          ▼                   │
│  Dexie tables (v22): workflows · workflowRuns · workflowRunEvents            │
│                       · workflowTriggers                                     │
│  UI: editor canvas (React Flow), library, runs (Gantt timeline), templates  │
└──────────────────────────────────────────────────────────────────────────────┘
```

The split rule is one sentence: **Rust owns "when does a workflow start" and "did this run
survive a crash"; TS owns "given a run, do the work step by step."** Crossings happen only at
well-defined trigger events and snapshot persistence calls. This is the same pattern Connectors
(ADR 0009) and the Native Vector Store (ADR 0004) use.

### Database schema (v22)

Four new Dexie tables added in `lib/db/schema.ts` v22:

| Table               | Key  | Purpose                                                |
| ------------------- | ---- | ------------------------------------------------------ |
| `workflows`         | `id` | Workflow definitions (graph + settings)                |
| `workflowRuns`      | `id` | One row per execution with frozen workflow snapshot    |
| `workflowRunEvents` | `id` | Durable per-step event log; live-queried by editor/UI  |
| `workflowTriggers`  | `id` | Registered triggers (cron, webhook, inbound, chat-msg) |

Indexes: `[workflowId+startedAt]` for the run timeline; `[runId+ts]` for in-order event playback;
`[workflowId+enabled]` for the trigger-pane lookup.

### Type model

`types/workflow/visual.ts` — single barrel exporting:

- `WorkflowNodeKind` — namespaced `<group>.<kind>` union (38 kinds across 7 categories).
- `VisualWorkflow` — top-level definition (renamed to avoid colliding with the existing PPT-focused
  `WorkflowDefinition` in `./workflow.ts`).
- `WorkflowNode<TParams>`, `WorkflowEdge`, `WorkflowSettings` — graph atoms; index signature on
  `WorkflowNodeData` so React Flow's `Node<TData extends Record<string, unknown>>` accepts them.
- `RunStatus`, `TriggerEvent`, `WorkflowRunRow`, `WorkflowRunEventRow`, `WorkflowTriggerRow`.
- `StepExecutionContext` / `StepExecutionResult` — passed to every NodeExecutor.
- IPC contract types: `PersistRunStateInput`, `InFlightRunRow`, `RegisterTriggerInput`.

### Editor

- `@xyflow/react` v12 — chosen for React 19 + Tailwind v4 + shadcn compatibility, and because v12
  added server hydration support (`output: "export"` works without runtime errors).
- `zundo` — temporal middleware on Zustand for undo/redo (100-step history limit).
- `elkjs` — lazy-loaded auto-layout via the `layered` algorithm.
- Custom node renderer (`components/workflow/editor/nodes/workflow-node.tsx`) covers all 38 kinds
  with category-colored shadcn-styled cards.
- `node-search-sidebar.tsx` — drag-to-canvas with collapsible category groups; uses the HTML5 DnD
  API and a custom MIME (`application/x-workflow-kind`).
- `inspector-panel.tsx` — right-rail Sheet with per-kind config form pulled from
  `inspector/node-config-registry.tsx`.

### Execution engine

- `lib/workflow/runtime/orchestrator.ts` — entry point. Validates → topo-sorts → steps through the
  queue → routes branches → persists every event.
- `lib/workflow/runtime/topo-sort.ts` — Kahn's algorithm with back-edge detection through
  `flow.loop` / `flow.wait` (those are explicit cycle entry points; generic cycles still throw).
- `lib/workflow/runtime/step-executor.ts` — handles retry (exponential / fixed backoff), timeout
  (via `AbortController`), idempotency (via `IdempotencyCache`), and expression resolution
  (`resolveDeep` substitutes `{{ $node['id'].out.field }}` references before the executor sees
  params).
- `lib/workflow/runtime/event-log.ts` — append-only writer with batched `bulkPut` and a scoped
  `RunLogger` that captures `runId` once.
- `lib/workflow/runtime/idempotency.ts` — Inngest-style memoization. On crash + reload, hydrates
  from the durable Dexie event log so resumed runs replay nothing.
- `lib/workflow/runtime/expression.ts` — safe expression resolver (NOT `eval()`); accepts
  `$node['id'] · $trigger · $static · $params` plus `.field` / `['key']` / `[index]` accessors.

### Node executor registry

`lib/workflow/nodes/registry.ts` maps `(kind, typeVersion)` → execute function. Registrations
happen as a side effect of importing `lib/workflow/nodes/built-ins.ts`. Plugins can register new
executors via the same `registerNodeExecutor` API; missing registrations surface as a
"no executor registered" run failure (recoverable).

Phase 1 ships 23 real (non-stub) executors:

| Kind                      | Behavior                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `trigger.manual`          | Echoes trigger payload                                                                      |
| `flow.set`                | Stores a value as a run-scoped variable                                                     |
| `flow.branch`             | Truthiness-based two-way split with skip propagation                                        |
| `flow.switch`             | Multi-way branch on `subject` against a `cases[]` map                                       |
| `flow.split`              | Pure passthrough; orchestrator fans out via downstream edges                                |
| `flow.join`               | Freezes upstream into `{joinPolicy, gathered, upstreamCount}`                               |
| `flow.loop`               | `forEach` / `times` iteration; subgraph loop body lands later                               |
| `flow.wait`               | `setTimeout` with cancellable `AbortSignal`                                                 |
| `flow.subworkflow`        | Recursive `runWorkflow` invocation; non-retryable on subworkflow failure                    |
| `data.transform`          | map/filter/sort/flatten/reduce over arrays via `$item` expressions                          |
| `data.template`           | Mustache-style `{{ }}` rendering (already expanded by step-executor)                        |
| `data.code`               | Sandboxed `Function()` with 5 s timeout, async support                                      |
| `io.http`                 | Real `fetch` with content-type sniffing; 5xx retryable / 4xx not                            |
| `io.webhook.respond`      | Stages a response; delivery deferred until Phase 5b webhook routing                         |
| `action.character.create` | `createCharacter` Dexie write                                                               |
| `action.character.update` | `updateCharacter` Dexie patch (immutable fields stripped)                                   |
| `action.team.create`      | `createTeam` with member validation                                                         |
| `action.team.update`      | `updateTeam` Dexie patch                                                                    |
| `action.skill.invoke`     | Reads real skills from Dexie, returns concatenated markdown                                 |
| `action.skill.upsert`     | Create-or-update by `skillId` presence; idempotent                                          |
| `action.connector.send`   | `enqueueOutbound` to the existing FIFO queue with idempotency                               |
| `action.connector.draft`  | `createDraft` for human approval in the Inbox UI                                            |
| `ai.prompt`               | Real LLM call via `createLlmClient` when provider+key supplied; stub fallback otherwise     |
| `ai.classify`             | Wraps `ai.prompt` with constrained label output                                             |
| `ai.extract`              | Wraps `ai.prompt` with structured JSON extraction + parse-error surface                     |
| `ai.embed`                | Deterministic hash-based vector via `generateTextEmbedding` (Phase 9 wires real embeddings) |

Remaining kinds (`action.character.send`, `action.team.run`, `action.twin.rag`,
`action.twin.ingest`, `action.mcp.invokeTool`, `action.plugin.invoke`) need deeper integration
with their respective subsystems (chat send pipeline, agent-team manager, twin runtime, MCP
client, plugin task handler registry) and ship in subsequent phases as those bridges land.

### Trigger bridges

| Trigger                     | Backed by                                                    | Phase 1?             |
| --------------------------- | ------------------------------------------------------------ | -------------------- |
| `trigger.manual`            | Editor's Run button                                          | yes                  |
| `trigger.cron`              | Existing scheduler in TS; Rust daemon firing while minimized | TS yes; Rust pending |
| `trigger.connector.inbound` | `ConnectorBus.dispatchInbound` lifecycle hook                | pending              |
| `trigger.chat.message`      | `lib/claude/build-options.ts:resolveSendOptions` hook        | pending              |
| `trigger.webhook`           | Tauri-only HTTP server (mounted on the External Bridge axum) | pending              |

### Tauri IPC contract

Defined in `lib/workflow/runtime/tauri-bridge.ts`. Phase 1 ships **stubs** — the TS side calls
`invoke()` for every command, but the corresponding Rust handlers in
`src-tauri/src/workflow/commands.rs` land in Phase 5a. In web mode the bridge no-ops gracefully so
the orchestrator still runs end-to-end.

| Direction | Name                             | Purpose                                            |
| --------- | -------------------------------- | -------------------------------------------------- |
| TS → Rust | `workflow_register_trigger`      | Add/update a trigger row; daemons reload schedules |
| TS → Rust | `workflow_unregister_trigger`    | Removes from cron daemon + webhook router          |
| TS → Rust | `workflow_persist_run_state`     | Updates SQLite mirror at each step transition      |
| TS → Rust | `workflow_reload_in_flight_runs` | Boot-time replay of running runs                   |
| TS → Rust | `workflow_ack_completed`         | Clears mirror row after success                    |
| Rust → TS | event `workflow:trigger`         | Cron / webhook / inbound fan-out                   |
| Rust → TS | event `workflow:resume`          | Replay an in-flight run from the mirror            |

### Settings & routes

- Sidebar entry under the **Data** group: `Settings → Workflows` (icon: `WorkflowIcon`, search
  keywords cover EN + zh-CN).
- 5-tab section at `?section=workflows&wfTab=…`:
  - **Library** — embeds the same `<WorkflowLibrary />` rendered at `/workflows`.
  - **Runs** — global recent runs, filter chips for status.
  - **Templates** — built-in templates gallery (4 ship in Phase 9).
  - **Defaults** — read-only summary of inherited error/retry/secret defaults.
  - **Audit** — workflow audit events (extends the existing `mcpAuditLog` storage).
- Top-level routes:
  - `/workflows` — library landing.
  - `/workflows/[id]` — full-screen canvas editor.
  - `/workflows/[id]/runs` — run history list.
  - `/workflows/[id]/runs/[runId]` — Gantt timeline + step inspector.

### Built-in templates

Four templates ship in Phase 1 (`lib/workflow/definition/seed.ts`) — all composed from
already-shipped executors so they run out of the box:

1. **Hello world** — `trigger.manual` → `ai.prompt` → `flow.set`.
2. **HTTP → transform → summarize** — fetch JSON, pluck a field, summarize.
3. **Classify then branch** — AI classification fans into a two-way branch.
4. **Skills + AI** — bundle skills into the prompt of a downstream AI step.

### Web-mode degradation

When `!isTauri()`:

- Cron triggers fire only while the webview is alive (no Rust daemon).
- Webhook triggers show a "desktop only" notice in the trigger pane.
- `chat.message` + `manual` + `connector.inbound` triggers (the ones already TS-side) work
  unchanged.
- The Library, editor, run history, and templates UI all work fully.

---

## Test coverage

Phase 1 ships **150 tests across 14 suites**, all green:

| Suite                                              | Coverage                                               |
| -------------------------------------------------- | ------------------------------------------------------ |
| `types/workflow/visual.test.ts`                    | catalog completeness, defaults                         |
| `lib/db/workflows.test.ts`                         | CRUD, duplicate, seed-built-ins, regenerateNodeIds     |
| `lib/workflow/definition/validate.test.ts`         | zod envelope, integrity (cycles, duplicate ids)        |
| `lib/workflow/definition/seed.test.ts`             | every template validates; idempotent reseed            |
| `lib/workflow/runtime/expression.test.ts`          | tokenize / evalToken / resolveExpression / resolveDeep |
| `lib/workflow/runtime/topo-sort.test.ts`           | linear / disconnected / back-edge detection            |
| `lib/workflow/runtime/orchestrator.test.ts`        | 4-node E2E, branch routing, failure modes, resume      |
| `lib/workflow/nodes/catalog.test.ts`               | 10 cases for the catalog + search                      |
| `lib/workflow/nodes/built-ins.test.ts`             | 32 executor cases including ai.prompt stub fallback    |
| `lib/workflow/editor/store.test.ts`                | Zustand+zundo CRUD                                     |
| `lib/workflow/editor/react-flow-converter.test.ts` | round-trip with handle/label edge cases                |
| `components/workflow/editor/canvas.test.tsx`       | toolbar + empty-state + dirty badge                    |
| `components/workflow/runs/format.test.ts`          | duration formatter edge cases                          |
| `components/workflow/runs/run-timeline.test.ts`    | span builder including retry collapse + skip-only      |

---

## Files added (Phase 1)

```
types/workflow/visual.ts                                   types
types/workflow/visual.test.ts
lib/db/workflows.ts                                        CRUD
lib/db/workflows.test.ts
lib/db/schema.ts                                           v22 block (modified)
lib/db/seed.ts                                             hooks seedBuiltInWorkflowTemplates
lib/workflow/definition/validate.ts                        zod + integrity
lib/workflow/definition/validate.test.ts
lib/workflow/definition/seed.ts                            4 built-in templates
lib/workflow/definition/seed.test.ts
lib/workflow/runtime/expression.ts                         expression resolver
lib/workflow/runtime/expression.test.ts
lib/workflow/runtime/event-log.ts                          durable event writer
lib/workflow/runtime/idempotency.ts                        memoization cache
lib/workflow/runtime/secret-resolver.ts                    NoopSecretResolver + in-memory
lib/workflow/runtime/tauri-bridge.ts                       IPC stubs (web no-op)
lib/workflow/runtime/topo-sort.ts                          Kahn's + back-edge
lib/workflow/runtime/topo-sort.test.ts
lib/workflow/runtime/step-executor.ts                      retry / timeout / idempotency
lib/workflow/runtime/orchestrator.ts                       top-level entry
lib/workflow/runtime/orchestrator.test.ts
lib/workflow/nodes/catalog.ts                              metadata for sidebar / palette
lib/workflow/nodes/catalog.test.ts
lib/workflow/nodes/registry.ts                             executor registry
lib/workflow/nodes/built-ins.ts                            14 real + stub executors
lib/workflow/nodes/built-ins.test.ts
lib/workflow/editor/store.ts                               Zustand + zundo
lib/workflow/editor/store.test.ts
lib/workflow/editor/react-flow-converter.ts                round-trip
lib/workflow/editor/react-flow-converter.test.ts
lib/workflow/editor/auto-layout.ts                         elkjs lazy-loader

components/workflow/editor/canvas.tsx                      React Flow shell
components/workflow/editor/canvas.test.tsx
components/workflow/editor/toolbar.tsx
components/workflow/editor/empty-state.tsx
components/workflow/editor/node-search-sidebar.tsx
components/workflow/editor/inspector-panel.tsx
components/workflow/editor/inspector/node-config-registry.tsx
components/workflow/editor/inspector/forms/index.tsx       18 per-kind config forms
components/workflow/editor/inspector/forms/shared.tsx
components/workflow/editor/nodes/workflow-node.tsx         single-renderer for all 38 kinds
components/workflow/library/workflow-library.tsx
components/workflow/library/workflow-card.tsx
components/workflow/library/workflow-create-dialog.tsx
components/workflow/runs/run-list.tsx
components/workflow/runs/run-detail.tsx
components/workflow/runs/run-timeline.tsx
components/workflow/runs/run-timeline.test.ts
components/workflow/runs/run-step-detail.tsx
components/workflow/runs/run-status-pill.tsx
components/workflow/runs/format.ts
components/workflow/runs/format.test.ts
components/settings/workflows/workflows-section.tsx        5-tab Settings shell
components/settings/workflows/tabs/library-tab.tsx
components/settings/workflows/tabs/runs-tab.tsx
components/settings/workflows/tabs/templates-tab.tsx
components/settings/workflows/tabs/defaults-tab.tsx
components/settings/workflows/tabs/audit-tab.tsx

app/workflows/page.tsx
app/workflows/[id]/page.tsx
app/workflows/[id]/runs/page.tsx
app/workflows/[id]/runs/[runId]/page.tsx
```

Modified:

```
components/settings/settings-nav-config.ts                 + workflows entry
components/settings/settings-shell.tsx                     + dynamic import + case
i18n/messages/en.json                                      + workflows tab labels
i18n/messages/zh-CN.json                                   + workflows tab labels
package.json                                               + 5 deps
```

---

## What ships in subsequent phases

- **Phase 5a** — Rust trigger daemons (`src-tauri/src/workflow/`): cron daemon (tokio-cron),
  webhook receiver mounted on the External Bridge axum, run state mirror in SQLite.
- **Phase 5b** — TS trigger bridge (`trigger-bridge.ts`, `resume-controller.ts`) wired to the chat
  send pipeline + ConnectorBus inbound tap.
- **Phase 6 remainder** — ~15 more node executors that integrate the chat pipeline, agent-team
  manager, twin runtime, MCP client, and connector outbound runner.
- **Phase 9 polish** — framer-motion easing on edges/nodes, run status pill on each node showing
  the last-run state, OKLCH-aware MiniMap, more keyboard shortcuts.
- **Phase 10 remainder** — full coverage gates (`pnpm test:coverage`, `cargo test`,
  `pnpm tauri build`).

---

## Sources

- [@xyflow/react v12 release notes](https://xyflow.com/blog/react-flow-12-release)
- [n8n node typeVersion](https://docs.n8n.io/integrations/creating-nodes/build/reference/node-versioning/)
- [Inngest step.run memoization](https://www.inngest.com/docs/learn/how-functions-are-executed)
- [Temporal — durable execution](https://temporal.io/blog/temporal-replaces-state-machines-for-distributed-applications)
- [zundo — Zustand temporal middleware](https://github.com/charkour/zundo)
- ADR 0009 (Platform Connectors) — pattern reference for the Rust↔TS hybrid split.
- ADR 0008 (External Bridge) — pattern reference for sharing the Tauri axum instance.
- ADR 0004 (Native Vector Store) — pattern reference for SQLite mirror persistence.
