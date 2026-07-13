---
title: ADR-0069 — Long-term memory subsystem & external API surfaces
description: "Documents the autonomous long-term memory subsystem (Dexie v65, hybrid retrieval, per-turn extraction) and de-silos it behind three callable surfaces: a ctx.memory plugin API (memory:read/memory:write), five MCP bridge tools on opt-in scopes, and five companion RPCs with a mobile read mirror — all writing through one shared, PII-gated helper layer with a new `external` provenance."
---

# ADR-0069 — Long-term memory subsystem & external API surfaces

**Status**: Accepted (2026-07-14)
**Authors**: Max Qian + Claude Fable 5
**Builds on**: the Digital Twin runtime (ADR-0003, shared embedding/vector backend), the external bridge MCP server (ADR-0008), the companion remote-control surface (ADR-0005 / ADR-0060 / Wave 4.1), the plugin permission model (ADR-0032, `goal:read`/`goal:write` precedent), and the visual-workflow memory nodes (ADR-0011).

## Context

The autonomous long-term memory subsystem (`lib/memory/**`, `types/memory/`,
Dexie v65 `memories` table) has been fully wired internally since it shipped:
per-turn extraction (`runTurnMemory` from the chat + team hooks), hybrid
BM25+vector recall injected via `resolveSendOptions` (the
"What you remember about the user" section), connector auto-mode recall,
`/remember` explicit capture, workflow store/recall nodes, the `/memory`
console, and a mobile read-only sync mirror (`memories` in
`sync_registry.rs`). It had **no ADR** — code comments pointed at a spec file
that was never committed — and **no callable API surface**: plugins, external
MCP agents, and paired devices could not read or write memory at all.

Known defects fixed alongside: `MemoryConfig.hybridEnabled` was inert (only
the settings toggle read it); the workflow recall node and the pet recall
bridge ignored `decayHalfLifeDays`; a stale docstring claimed team
shared-memory object values bypass the PII gate (they are deep-gated); and
`/remember`'s `openMemory` flag was never consumed.

## Decision

### 1. One shared helper layer — `lib/memory/api/`

Every non-conversational surface writes/reads through four helpers, never
straight at Dexie:

- `store-memory.ts` — `storeMemoryCore` (the `/remember`-parity deliberate
  write: consolidator-preferred, direct-insert + vector-sink fallback) and
  `storeExternalMemory` (external wrapper). The workflow
  `action.memory.store` node now delegates here too.
- `search-memory.ts` — `searchMemoriesExternal`: config-gated hybrid recall
  threading the user's `retrievalTopK` / `relevanceFloor` /
  `decayHalfLifeDays` / `enableQueryExpansion`; `touch` on by default with a
  diagnostics opt-out.
- `mutate-memory.ts` — `updateExternalMemory` (PII-gated text patches, bumps
  `version`, re-upserts the vector doc) and `forgetExternalMemory`
  (soft-invalidate only — hard deletes stay user-panel-only).
- `wire.ts` — `toMemoryWireRow`, the boundary projection that strips internal
  plumbing (`vectorDocId`, access counters, attribution internals).

Policy blocks return structured results (`{ ok: false, reason: "disabled" |
"temporary" | "pii_blocked" | "not_found" | "backend_unavailable" }`);
caller programming errors throw.

### 2. Trust invariants (all surfaces)

- **Provenance `external`** — a new `MemoryProvenance` value for every
  API-surface write, ranked between `explicit` and `system` in retrieval
  veracity (0.85). The concrete surface is stamped in new unindexed row
  fields `sourceChannel: "plugin" | "mcp" | "rpc"` and `sourcePluginId`
  (no Dexie version bump — additive, unindexed).
- **Never procedural** — external writes may only create `semantic` /
  `episodic`; the pre-existing invariant that only `user`/`explicit`
  provenance may rewrite agent behavior is enforced in `storeMemoryCore`.
- **PII block gate** — external stores and text updates must pass
  `hasNoLeakingPii` (block-only; the redact option stays workflow-local
  because external callers cannot consent on the user's behalf).
- **Config gates** — `memory.enabled` gates everything; `temporary` blocks
  reads and writes (forget stays allowed — it only reduces data).

### 3. Plugin API — `ctx.memory` (manifest permissions `memory:read` / `memory:write`)

Follows the goal pattern (manifest-level `PluginPermission` + TS validator +
`cognia plugin lint` Rust parity in `cmd_lint.rs` + `createGuardedAPI`),
not the vector API-permission pattern, so grants are visible at install
review. `search/list/get/count` need `memory:read`; `store/update/forget`
need `memory:write` (not dangerous-tier — same as `goal:write`). Reads
degrade to empty when memory is off; `store` throws a typed
`PluginPiiError` on PII. No capability contract or bridge-map entry
(imperative API, like `goals`).

### 4. MCP bridge tools — scopes `memory:read` / `memory:write`, both default OFF

`memory_search` / `memory_list` (read scope), `memory_store` /
`memory_update` / `memory_forget` (write scope, forget flagged
`destructiveHint`). Registered in `registerMemoryTools`
(`lib/external-bridge/mcp-server/server.ts`), handlers in
`lib/external-bridge/handlers/memory.ts`, every call through `runWithGate`
(permission gate + audit log). Both scopes stay out of
`DEFAULT_ENABLED_SCOPES` — memories are distilled personal facts, the same
sensitivity tier as `rag:twin`. Settings toggles render automatically from
`ALL_BRIDGE_SCOPES`.

### 5. Companion RPC — five `/_rpc/memory_*` commands

All route through the desktop_writes_bridge to
`lib/companion/desktop-write-source.ts` arms (`sourceChannel: "rpc"`).
Classification: `memory_store`/`memory_update`/`memory_forget` are
`CONTROL_COMMANDS` (Wave 4.1 policy — every remote mutation of a powerful
surface is gated); `memory_list` is `READ_ONLY_COMMANDS`;
**`memory_search` is deliberately neither** — it bumps
`lastAccessedAt`/`accessCount` (the recency signal), so idempotency-caching
it would freeze decay. No `MOBILE_OUTBOUND_COMMANDS` entries (that list's
invariant requires a production mobile enqueue site; the phone reads the
existing `memories` sync mirror, which has `has_tombstones: false` — hard
deletes age out passively).

### 6. `/memory` manage command

`/memory` opens the console; `status` / `list [n]` / `forget <id>` manage it
from chat — the read/manage counterpart to `/remember`, whose `openMemory`
flag is now actually consumed (`ctx.openSettings("memory")`).

## Consequences

- Three call surfaces share one gate/consolidation implementation — a PII or
  trust-model fix lands once in `lib/memory/api/`.
- The memory console can attribute and bulk-clean API-written rows via
  `provenance: "external"` + `sourceChannel`.
- Parity gates that must stay green when touching the surfaces:
  `rust-capability-parity.test.ts` (TS ↔ `cmd_lint.rs` permissions),
  `spec_parity.rs` (`KNOWN_COMMANDS` ↔ OpenAPI), the rpc.rs classification
  sentinels, and the en/zh-CN i18n key parity for the new scope/provenance
  strings.

## Out of scope (deliberate)

- **Twin-embedding coupling** — memory recall still borrows the twin's
  embedding/vector backend (`tryBuildMemoryDeps` → `tryBuildTwinDeps`); a
  user who never configured twin embeddings silently gets BM25-only memory.
  An independent memory-embedding config remains future work.
- **Maintenance-trigger redesign** — episodic distillation still fires on
  idle-after-turn once per session per app run; sessions never revisited
  after a restart are not re-distilled.
- **Inbound IM content** continues to be excluded from memory writes by the
  provenance gate (read-recall only) — unchanged, by design.
