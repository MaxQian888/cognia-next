# tutti-inspired optimizations — verified against cognia-next

**Date:** 2026-07-09
**Status:** research record (not yet an ADR; no code changed)
**Source study:** [tutti-os/tutti](https://github.com/tutti-os/tutti) (Electron desktop + Go `tuttid` daemon; a real-time shared workspace for AI coding agents)

## How this document was produced

1. Cloned and deep-studied tutti across six subsystems (agent orchestration, event/shared-workspace model, workbench/desktop shell, apps-ecosystem + agent-callable CLI, collaboration UX, engineering practices) via six parallel research agents. That produced ~70 candidate "ideas to steal."
2. **Then verified every idea against cognia-next's real code** with six more agents (one per subsystem), each opening the actual files and returning a per-idea verdict with `file:line` evidence. This document records **only the verified results** — the unverified mapping is discarded.

**Headline finding:** cognia is far more mature than the tutti study assumed. ~2/3 of the candidate ideas were already implemented (often more robustly) or rested on stale premises. What survives below is the curated set that is _genuinely absent and effective_.

**Legend:** ✅ CONFIRMED (absent, applicable, effective) · 🟡 PARTIAL (cognia partly does it; a specific slice is missing) · ❌ REJECTED (already implemented / not applicable — see appendix).

---

## Tier 1 — Confirmed, genuinely absent, worth doing

| #   | Optimization                                              | Effort | Primary landing spot                           |
| --- | --------------------------------------------------------- | ------ | ---------------------------------------------- |
| 1   | Command-name parity guard (invoke ↔ `generate_handler!`)  | S      | `scripts/gates/check-silent-failure-flags.mjs` |
| 2   | Deterministic static-export guard                         | S      | new `scripts/gates/` script + CI               |
| 3   | i18n changed-files zero-tolerance + key-existence check   | S      | `scripts/gates/lint-i18n.ts`                   |
| 4   | Single-source config defaults (companion port, state dir) | S      | `scripts/sync/version-sync.mjs` pattern        |
| 5   | `useSyncExternalStore` for the fleet island stream        | S–M    | `hooks/fleet/use-fleet-stream.ts`              |
| 6   | Control Center — unified attention surface                | M–L    | new store over fleet + gates + chat            |

### 1. Command-name parity guard ✅ — _two independent verifiers converged on this_

- **Gap (verified):** the Tauri surface is one hand-maintained `tauri::generate_handler![...]` of **770 entries** (`src-tauri/src/lib.rs:379-1053`, 658 `#[tauri::command]` attrs), and the TS side calls them as **string literals** via `invoke<T>("name")` (~190 callsites, e.g. `lib/tauri/fleet.ts:20`). A mistyped/unregistered name fails only at runtime as a rejected promise — no build- or test-time link. No `specta`/`tauri-specta`/`ts-rs` present.
- **Why effective:** this is cognia's #1 recurrent defect class (built-but-dormant / unregistered command) made into a red/green gate. cognia already proves the technique for the `plugin_*` subset.
- **How:** extend `scripts/gates/check-silent-failure-flags.mjs` (which already statically verifies `plugin_*` invoke → registered command) to assert every `invoke("x")` string literal ∈ the `generate_handler!` set. Add to `.github/workflows/quality.yml`.

### 2. Deterministic static-export guard ✅

- **Gap (verified):** no deterministic check exists; enforcement is only the `static-export-auditor` LLM subagent (advisory, not in CI/husky). ESLint has no `node:*` restriction (`eslint.config.mjs`).
- **Scope correction:** the tutti mapping referenced `SERVER_ONLY_PACKAGES`/`serverExternalPackages` — **those no longer exist** in `next.config.ts` (only a tombstone comment at `next.config.ts:78-80`). The real list is `NODE_ONLY_MODULES` (`next.config.ts:92-115`). Only **6 files** currently import `node:*` in bundled dirs (`lib/plugin/launcher/launchPluginJs.ts`, `lib/plugin/contracts/contract-path-audit.ts`, `lib/external-bridge/mcp-server/standalone-entry.ts`, `lib/github/{event-normalizer,webhook-verify}.ts`, `lib/skills/built-in/lark/exec-lark-cli.ts`) — all server-ish.
- **Why effective:** cleanest LLM-auditor→deterministic-gate conversion in the repo; tiny allowlist.
- **How:** grep guard denying `node:*` (list parsed out of `next.config.ts` so it never drifts) + server SDK imports from `app/`/`components/`/`hooks/`/`stores/`; 6-entry allowlist + inline `// static-export-exempt: <reason>` escape.

### 3. i18n changed-files zero-tolerance + referenced-key-existence ✅

- **Gap (verified):** `scripts/gates/lint-i18n.ts:360` gates on `findings.length > baselineCount` where `baselineCount = 488` (`scripts/i18n-baseline.json`) — a **whole-repo count ceiling**, so a new hardcoded string passes as long as an old one is removed. The en/zh **key-parity** check is already deterministic (`lint-i18n.ts:104`), but the **referenced-key-exists** check (every `t("…")` present in both JSONs) is done only by hand by the `i18n-reviewer` subagent.
- **Why effective:** closes the exact "new strings slip in until the count rises" hole, and `scanFile` is already exported (`lint-i18n.ts:427`) so the changed-files mode is a small addition.
- **How:** add a `--staged` mode (`git diff --cached`, `baseline=0`) reusing `scanFile`; add a code→JSON key-existence scan reusing `flattenKeys`; replace the opaque count with an inline `// i18n-exempt: <reason>` escape (cognia already has a path-fragment tier at `scripts/i18n-ignore.txt`, but no per-line attributable escape).

### 4. Single-source config defaults ✅

- **Gap (verified):** the companion port is canonical in Rust (`src-tauri/src/companion_api/server.rs:59` `DEFAULT_PORT = 27890`) and **hand-mirrored** into ≥3 TS sites (`components/settings/companion/companion-section.tsx:59-61`, `lib/connectivity/lan-scanner.ts:110-112`, `lib/connectivity/lan-resolver.ts:27`), each with a "Mirrors Rust…" comment. The state-dir literal `"cognia"` is repeated across ~10 Rust files.
- **Why effective:** the "one canonical value, N mirrors, `--check` in CI" pattern is _already embraced by the team_ for the app version (`scripts/sync/version-sync.mjs`, TARGETS at 41-51). Pointing it at the port is a natural, drift-proof extension.
- **How:** add the companion port (and optionally the state-dir name) to a `version-sync`-style single-source generator with a `--check` gate. Port is high-value; dir literals lower.

### 5. `useSyncExternalStore` for the fleet island ✅

- **Gap (verified):** the fleet stream is effect-based — `useEffect` + dynamic `listen(FLEET_UPDATE_EVENT)` / manual `unlisten` guarded by an `aliveRef` against the StrictMode double-mount race (`hooks/fleet/use-fleet-stream.ts:31-61`), plus a second `useEffect`+`listen` for geometry needing `safeUnlisten` (`components/fleet/island-shell.tsx:81-101`).
- **Why effective:** cognia **already** uses `useSyncExternalStore` for an external event source (plugin-i18n `LocaleGate`, `lib/i18n/plugin-i18n-registry.ts:90-109`), so the fleet island is the outlier. Migrating removes the `aliveRef`/`safeUnlisten` dance and fixes the class of StrictMode subscription races at the framework level.
- **How:** wrap the Tauri `listen` in a small external-store adapter (`subscribe` = `listen`, `getSnapshot` = cached snapshot) and consume via `useSyncExternalStore`.

### 6. Control Center — unified attention surface ✅ (highest-value new build)

- **Gap (verified, genuinely absent):** the three "needs-your-attention" sources are separate stores never aggregated — fleet permission lives in the fleet snapshot (`hooks/fleet/use-fleet-stream.ts`), agent-team HITL gates in `stores/agent/pending-gates-store.ts`, chat approvals per-session in `stores/chat/chat-store.ts` as `PendingApproval[]`. The fleet island aggregates only fleet sessions (`components/fleet/island-shell.tsx:21`), not team gates or chat approvals.
- **Why effective:** one surface for "every pending approval + running task + conversation that needs me" across chat, agent-team, and external fleet agents — the single biggest UX leverage tutti demonstrates (its `AgentActivityRuntime` attention dock). cognia has all the underlying stores; it lacks the aggregator.
- **How:** a read-only aggregation store subscribing to the three sources, projecting a unified `AttentionItem[]`; surface it in the fleet island (or a dedicated panel). Pairs naturally with Tier-2 #7 (durable approvals).

---

## Tier 2 — Partial: cognia does most of it; a specific slice is missing and worth adding

### 7. Durable pending approval + distinct `interrupted` terminal 🟡

- **Verified state:** the sidecar approval promise already has **three terminals** — renderer answer (`sidecar/claude-host.mjs:451-460`), SDK abort (`sidecar/dispatch/anthropic.mjs:509-516`), teardown drain (`anthropic.mjs:78-104`). So the "guaranteed hang" framing is overstated.
- **What's genuinely missing:** (a) the approval is an in-memory `Map` keyed by requestId, not a durable/reconcilable item; (b) the drain resolves orphans as a **silent `deny`**, not a distinct `interrupted` state; (c) the renderer HITL mirror **drops on reconnect** by design — `stores/agent/pending-gates-store.ts:9-12` explicitly notes "no persist middleware … future v2 work could persist both together."
- **How:** model the approval as `{pending|resolved|interrupted}` keyed by requestId; on drain/reconnect mark orphans `interrupted` (re-offer) instead of silent deny; persist the gate mirror. This is the store side of Tier-1 #6.

### 8. Structured error envelope on the invoke path 🟡

- **Verified state:** most `#[tauri::command]`s return `Result<_, String>`, and even structured enums collapse to a plain string on the wire — `PluginError` does `serialize_str(&self.to_string())` (`src-tauri/src/plugin_api/error.rs:52-58`; same in `scheduler/error.rs`), losing variant/`retryable` info.
- **Premise correction:** the "tuple returns serialize as JSON arrays" rationale is **false** here — zero commands return tuples (the 26 `Result<(A,B)>` hits are internal helpers).
- **Why still effective:** the HTTP side already has the exact envelope worth adopting — `CompanionError { code, retryable }` (`lib/tauri/transport-companion.ts:115-133`). Bringing it to the invoke path gives the renderer machine-actionable, retryable-aware errors.
- **How:** a shared `CommandError { code, retryable, message }` struct serialized as an object; migrate high-value commands incrementally.

### 9. Enforce the acceptance gate on the agent-team auto-path + add a goal acceptance gate 🟡

- **Verified state:** board status is **already run-driven** (`lib/ai/agent/team/dispatch-teammate.ts:674,625,639`; dependency-derived `blocked` and runtime-owned `claimed`/`in_progress` in `task-move-guard.ts:57-90`), and a human-owned `review → completed|failed` transition already exists (`task-move-guard.ts:86`). `/goal` status is fully run/judge-derived (`lib/goal/turn-driver.ts:354`).
- **What's missing (tutti's `pending_acceptance`):** the auto path **bypasses** the review gate — a successful run jumps straight to `completed` (`dispatch-teammate.ts:674`) rather than `review`; `/goal` auto-goes terminal with **no** human-acceptance gate.
- **How:** optionally route auto-success → `review` (opt-in per team/task), and add an optional goal acceptance step before terminal. Small, high-trust improvement for multi-agent work.

### 10. PII-gate funnel guard (complementary, not a replacement) 🟡

- **Verified state:** choke points are real and broadly adopted — `hasNoLeakingPii` (`lib/twin/ingest/redact.ts:392`), `safeSendPrompt` (`lib/connectors/ai-loop/safe-send-prompt.ts:109`), 60+ callers. Enforcement today is **only** the `pii-gate-auditor` LLM subagent (advisory, not in CI). Additionally, the companion write seam (`src-tauri/src/companion_api/desktop_writes_bridge.rs`) is a natural place to enforce the gate but does not today.
- **Caveat:** a deterministic funnel can only prove "provider egress is centralized" — it cannot prove "this payload was user-derived and gated" (branch-aware data-flow), which still warrants the LLM auditor. So this **augments**, not replaces.
- **How:** a guard forbidding new AI-SDK/provider-`fetch` egress outside sanctioned modules with `// pii-gate-exempt: <reason>` escapes (surface: 19 AI-SDK calls across 13 files + the `lib/claude/` send paths); optionally enforce `hasNoLeakingPii` at the companion write seam.

### 11. Structured mention handles + unified @-provider registry 🟡

- **Verified state:** prompt-bloat is **already avoided** — `@file` inserts a compact `@path` token the CLI resolves natively (`components/chat/composer-trigger.ts:214-230`), cognia never reads file content into the composer. Mention kinds exist (`TriggerKind`: file/agent/skill/preset/wfNode/wfEdge) but are wired **ad-hoc** through separate hooks unioned imperatively in `components/chat/composer.tsx:414-424`; mentions persist as inline markdown re-parsed by regex (`lib/slash-commands/parse-segments.ts:169-222`), not as structured `{kind,id}` rows.
- **Why effective:** a single provider registry (replacing the ad-hoc hook union) + structured handle persistence makes mentions searchable/auditable and makes adding a new referenceable kind a registration, not a composer edit.
- **How:** introduce a mention-provider registry keyed by kind; persist a structured `ContextRef`-style handle alongside the inline token. (Note: a past-conversation `agent-session` mention kind and a cross-agent artifact `@generated-file` kind are genuinely absent and would be **new features**, not optimizations — track separately.)

### 12. Plugin factory: emit a co-located test + boot healthcheck 🟡

- **Verified state:** `scaffoldPlugin` exists (`lib/plugin/utils/templates.ts:1719`) and produces manifest + entry, but emits **no co-located test** (violates the repo's hard co-located-test rule) and does **no boot/healthcheck** (validation is static only: `core/validation.ts`, `core/verification.ts`).
- **How:** have the scaffold emit a `*.test.ts` stub and run a load/boot healthcheck before declaring success. Small, and it aligns the generator with the repo's own rules.

---

## Tier 3 — Low ROI / optional (confirmed-absent but small benefit)

- **Semantic z-index token ladder** (C12) ✅-absent — `app/globals.css` has only raw values; but only **6** arbitrary `z-[...]` escapes exist repo-wide, so ROI is low. Worth a token ladder + lint only if stacking bugs recur.
- **Change-scoped all-gates runner + `push:checked`** (F1-9) 🟡 — a full-repo `check-all.mjs` and per-gate `*:changed` variants exist, but no single change-scoped runner fanning out lint+typecheck+i18n+test+rust, and no force-with-lease safe-push wrapper. Nice-to-have dev-loop ergonomics.
- **`references`/artifact registry for plugins** (D3+D4) 🟡 — data root + Rust `resolve_scoped` sandbox exist (`src-tauri/src/plugin_api/api_bridge.rs:210`), but there's no reference-enumeration capability and no Dexie artifact registry keyed by `{sessionId,pluginId,artifactId}` (the current `stores/artifact/artifact-store.ts` is localStorage/id-keyed, LRU-capped). A real cross-agent artifact-handle store is a larger, lower-priority build.
- **Forced-first-tool-call routing preamble** (D5) 🟡 — the injection point (`lib/claude/build-options.ts:886 resolveSendOptions`), a per-plugin capability snapshot (`lib/plugin/api/plugin-capability-registry.ts:115`), and a semantic `toolRoutes` table all exist; only the "forced first call" behavior is new. Cheap but niche.
- **`catalogRevision` handshake fuse** (F1-5) 🟡 — the companion pairing already exchanges `server_version` (`src-tauri/src/companion_api/auth.rs`), but treats it as informational, not a decode fuse. A contract-revision that degrades a stale renderer gracefully is net-new, modest value.
- **Change Routing Matrix doc** (F1-7) 🟡 — routing intent is split across the CLAUDE.md Subsystem Map (ADR column) and `WORKFLOW.md` task tiers; consolidating into one "touch X → read ADR N → run gate Y" table is a docs nicety.
- **Headless-companion plugin CLI broker** (D2, narrowed) 🟡 — the desktop agent→plugin path already works (`plugin_tool_exec` + `terminal_dock_*`); only the headless/mobile `plugin_*`/`terminal_*`/`skills_*` path is `headless_unsupported` (`src-tauri/src/companion_api/dispatch_host.rs:25`). Niche.

---

## Appendix — Verified already-implemented or not applicable (do not re-propose)

These were checked against real cognia code and **rejected**; recorded so future readers don't re-litigate them.

**Agent orchestration (cognia is already at tutti's target state):**

- Mid-turn steer into a live turn ❌ — infeasible with the underlying SDKs (neither Claude Agent SDK streaming `query()` nor AI-SDK `streamText` exposes mid-generation injection; `lib/claude/steer.ts:6-11`). cognia's client-side queue+replay is the correct workaround, not a defect.
- Single turn-lifecycle snapshot authority ❌ — no triplication exists; the Rust sidecar (`src-tauri/src/claude/sidecar.rs:451-512`) is a pure pipe, the chat store is sole authority with a monotonic `runId` (`stores/chat/chat-store.ts:133-137`).
- Turn-as-reducer / non-blocking observe ❌ — already an event-driven state machine reaching terminal from stream-end/error/interrupt (`sidecar/dispatch/anthropic.mjs`, `ai-sdk.mjs`); renderer observes transitions (`hooks/chat/use-claude-chat.ts:1769,1844`).
- Provider adapter normalization ❌ — single provider switch (`sidecar/dispatch/index.mjs:23-29`) + wire-shape normalizer (`event-adapter.mjs`); fleet already normalized behind one `FleetEvent`/`ingest` with an explicit `FleetCapabilities` (`lib/fleet/types.ts:37-42`).
- Delivery-cursor vs identity split ❌ — chat identity is by `id`, ordering by `[sessionId+createdAt]` with `now+i` tiebreak (`lib/db/messages.ts:126,198`); no same-ms drop possible.
- Write-time subagent lane ownership ❌ — already stamped from the SDK's `parent_tool_use_id` (`lib/claude/sdk-subagent-bridge.ts:101,143`); read-time `buildSubagentTree` only walks recorded edges.
- Fleet status read/detect split ❌ — `snapshot()` is a pure model read; pid probing is isolated to a 5s reaper with injected `pid_alive` (`src-tauri/src/fleet/registry.rs:414-436`, `mod.rs:325-360`).

**Rust/Tauri shell (already implemented):**

- Reveal-after-first-paint + off-screen clamp + idempotent unlisten ❌ — pet window (`src-tauri/src/pet_window/mod.rs:186,243-253,84-107`) and fleet island (`src-tauri/src/fleet/island_window.rs:338,379-389,164`) both do `visible(false)` + renderer-reveal + 8s safety net + pure clamp; `safeUnlisten` at `lib/tauri/safe-unlisten.ts:31`.
- Crash-restart controller ❌ — `src-tauri/src/supervision_backoff.rs` (saturating table + healthy-reset + injected `Instant` + unit tests).
- Bounded-queue drop-then-disconnect ❌ — `broadcast::channel(256)` + `Lagged` → close (`companion_api/event_bus.rs`, `ws.rs:160-162`).
- Server-authority single-writer ❌ — companion is hub-and-spoke, desktop is sole writer (`companion_api/desktop_writes_bridge.rs`, `rpc.rs:168-273`). (Only net-new: PII at the write seam — Tier-2 #10.)
- Since-cursor delta hydration ❌ — `event_bus.rs` monotonic `seq` + `subscribe(since)`; `GET /ws/v1/events?since=` and `sync_pull` RPC already implement it.
- Re-resolve-per-call loopback token ❌ — `CompanionTransport.call()` re-reads config each call (`lib/tauri/transport-companion.ts:302,336-339`); the desktop renderer uses in-process `invoke`, not loopback HTTP, so there's nothing to harden there.

**Collaboration / store / plugins (already implemented):**

- `/goal` breakdown persist-by-default + ordered batch ❌ — `lib/goal/subgoals.ts:89-96` + atomic write `lib/goal/runtime.ts:575-576`.
- Plugin i18n override-merge stack ❌ — `lib/i18n/plugin-i18n-registry.ts` (register + merge + `useSyncExternalStore` overlay); host-string override intentionally prevented.
- Declarative plugin view contributions + deterministic merge ❌ — `manifest.views[]` (`types/plugin/plugin.ts:1053`), host-resolved registration (`lib/plugin/registries/*`), first-wins `conflict-reporter.ts`.
- Agent→plugin invocation path ❌ — `buildPluginToolsManifest` → synthetic MCP → `plugin_tool_exec` (`lib/plugin/bridge/sidecar-tools-bridge.ts:147`, `lib/plugin/core/invoke-plugin-tool.ts:202`); agent can also drive the real terminal (`terminal_dock_*`). Only the headless-companion variant is missing (Tier-3).
- Plugin path-sandbox / guardrails ❌ — `resolve_scoped` jail + cwd validation + permission tiers + skill visibility (`src-tauri/src/plugin_api/api_bridge.rs:210`, `core/validation.ts`, `invoke-plugin-tool.ts:273-291`).

**Engineering practices (already-done or not applicable):**

- DO-NOT-EDIT banner discipline ❌ — already standard (`lib/skills/built-in-catalog.generated.ts`, `scripts/scaffold/config-codegen.mjs:18-24`).
- ≤800-line business-file cap ❌ — no cap; would fight deliberately-large protocol clients (`lib/ai/agent/external/*-client.ts`, 60–95 KB each); no splitter skills in this repo.
- Tauri-bridge funnel guard (ban `invoke` outside `lib/tauri/*`) ❌ — `invoke` is deliberately scattered across **57 files**; `lib/tauri/` is a set of domain wrappers, not a choke point. The productive move is the command-name parity guard (Tier-1 #1), not a funnel.
- Full import-graph dormant-feature detector ❌ (mostly) — unreliable for this app because components mount via plugin registries, slot manifests, string-keyed catalogs, dynamic imports, and `generate_handler` tables (not static import edges). Only the "new exported symbol whose sole importer is its own co-located test" slice is a clean deterministic check; the rest genuinely needs the `wiring-auditor` LLM.
- SHA-pinned vendored upstream protocol ❌ (mostly) — external agent clients (`acp-client.ts`, `codex-app-server-client.ts`, `opencode-client.ts`) are hand-maintained; these upstreams don't publish a single machine-readable spec to pin. A canonical-JSON fixture-drift gate is the only realistic slice.

---

## Suggested sequencing

1. **Quick deterministic gates first** (Tier-1 #1–#4): all small, all convert an advisory LLM auditor or a manual mirror into a CI gate. Highest certainty, lowest risk.
2. **Fleet island `useSyncExternalStore`** (#5): small, removes a known race class.
3. **Control Center + durable approvals** (#6 + Tier-2 #7 together): the biggest UX win; build the aggregation store and the durable approval model in one pass.
4. **Invoke error envelope + acceptance gates** (#8, #9): medium, incremental.
5. Everything in Tier 3 only if a concrete need arises.

The one-line thesis worth keeping from tutti even where cognia already wins: **every convention should be a script that fails CI, not a paragraph an auditor must remember to check** — cognia's 6 LLM auditors are advisory and cannot gate CI, while its `scripts/gates/*` already do. Tier-1 #1–#3 are three of those auditors becoming gates.
