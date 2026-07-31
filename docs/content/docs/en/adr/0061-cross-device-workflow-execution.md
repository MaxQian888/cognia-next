---
title: "0061 — Cross-Device Workflow Execution (Capability Foundation)"
description: "A layered plan for running workflows across desktop, mobile, browser, and headless cloud — starting with a platform capability vocabulary, node requirements, run preflight, and device capability reports."
---

# ADR 0061 — Cross-Device Workflow Execution

**Status:** Accepted (Phase 1 implemented)
**Date:** 2026-07-02
**Branch:** `dev`

> Referenced in code comments as "ADR-0060" during development; the number
> 0060 was concurrently claimed by the personal-knowledge-capture ADR, so
> this document is 0061. Code comments citing ADR-0060 for capability /
> deviceId work mean this document.

---

## Context

Every workflow run executes inside exactly one desktop WebView. Rust
(`src-tauri/src/workflow/`) owns "when does a workflow start" (cron daemon,
webhook router, UIA watcher) and crash recovery; the TS orchestrator
(`lib/workflow/runtime/orchestrator.ts`) owns all step execution. Every
"remote" surface that exists today — the remote-control API
(`start-from-remote.ts`), the companion `workflow_trigger_manual` RPC, IM
triggers — is *remote triggering of local execution*.

A study of the substrate (2026-07-02) found:

1. **No device identity in the workflow model.** `WorkflowTriggeredFrom`
   carried `source` but not *which device*; companion-triggered runs were
   recorded as `"ui"`.
2. **No capability model.** Platform gating was one editor-side boolean
   (`NodeCatalogEntry.desktopOnly`, 17 entries); the orchestrator did no
   runtime preflight, so e.g. the 15 `action.desktop.*` nodes on web failed
   inside their executors — after earlier steps had run with side effects.
   ~426 files branch ad hoc on `isTauri()`/`usePlatform()`.
3. **`pairedDevices` is an auth ledger**, not a scheduling substrate: JWT,
   TLS pin, rendezvous tuple, `allowRemoteControl` — no declared
   capabilities, no way to ask "can this phone scan a barcode".
4. **Strong transport foundations going unused**: the companion RPC
   allowlist is spec-parity tested with cross-transport idempotency; the
   WebRTC DataChannel (`cognia.v2`, ADR 0021) is symmetric — a phone could
   *serve* RPCs; push + mobile approval-card plumbing exists but never
   carries workflow events; `lib/capacitor/` wraps camera / geolocation /
   barcode / voice / share, none exposed as workflow nodes.
5. **The three existing "handoff" mechanisms** (team background/external
   handoff executors, task delegation, CLI→desktop session transfer) carry
   no device concept; `externalPickup.claimedBy` is the hardcoded string
   `"external-bridge"`.

## Decision

### Primary model: hub-orchestrated remote steps

The orchestrator stays where the state lives (today: the desktop; later: the
ADR-0059 headless brain). Cross-device execution means the hub dispatches
*individual steps* to a capable device and marshals the result back into the
run's event log — not migrating whole runs between devices. Rationale:

- Every existing remote surface already works this way (execute where the
  state lives, stream results back).
- Run state is deeply hub-local (Dexie event log, `run-cancel-registry`,
  wake-bus, idempotency cache, keyring secrets); replicating it is strictly
  harder than shipping expanded step params + outputs.
- Expressions are resolved by the hub *before* dispatch, so a remote
  executor needs no access to `$node`/`$vars` scope.

Whole-run transfer (a lease/claim protocol generalizing the team
external-pickup stamp, plus `workflowRunEvents` replication) is the Phase 4
complement for "desktop is shutting down, cloud finishes the run" — not the
foundation.

### The layer ladder

| Layer | What | Status |
| ----- | ---- | ------ |
| **L0** | Capability vocabulary + node `requires` + run preflight + device capability reports | **Implemented (Phase 1, this ADR)** |
| L1 | Per-node/workflow placement (`runOn: device \| capability`), resolved by the hub | Planned |
| L2 | `step_execute` / `step_cancel` RPC + event-channel streaming; phone serves RPCs over the symmetric WebRTC channel | Planned |
| L3 | Handoff unification: structured `PickupTicket` (device-targeted, leased) replacing `TeamExternalPickup`; run lease on `WorkflowRunRow`; cross-device cancel; symmetric session-handoff envelope | Planned |
| L4 | Platform-featured nodes: `action.mobile.{camera,scan,location,voice,share}`, `action.approval.request` (push → mobile approval card as a `decision` branch), mobile share-target trigger | Planned |
| L5 | Plugin linkage: manifest `runtimeCompatibility` consulted at validate time; plugin triggers running per-device with events routed to the hub; `plugin:<id>` capability tags | Partially (types) |

### Phase 1 (implemented)

1. **`lib/platform/capabilities.ts`** — pure-leaf capability vocabulary.
   `CapabilityId` = 18 core ids (`shell`, `pty`, `sidecar`, `keyring`,
   `uia-automation`, `ocr`, `camera`, `geolocation`, `barcode-scan`,
   `voice-record`, `share-sheet`, `push-display`, `biometric`, `webview`,
   `headless`, `always-on`, `connector-runtime`, `mcp-runtime`) plus
   `plugin:<id>` tags. `detectLocalCapabilities()` returns a frozen static
   baseline per `detectPlatform()` (tauri / mobile / web); `headless` is
   reserved for the ADR-0059 cloud brain. Ids are wire format — append-only,
   never renamed.

2. **Node requirements.** `NodeCatalogEntry.requires?: CapabilityId[]` and
   the same on `PluginNodeDef` (+ manifest mirror), copied into the plugin
   catalog at registration. `effectiveRequires()` maps a legacy bare
   `desktopOnly` to `["shell"]` (present exactly on the tauri baseline, so
   `desktopOnly` ≡ tauri-only). All 17 `desktopOnly` built-ins carry
   explicit backfills — webhook triad → `always-on`, git → `shell`,
   terminal → `pty` (script runner → `shell`) — and the 15 unflagged
   `action.desktop.*` nodes require `uia-automation` **without** gaining
   `desktopOnly` (palette visibility unchanged). The editor filter
   (`includeDesktopOnly`) is deliberately untouched.

3. **Run preflight** (`lib/workflow/runtime/capability-preflight.ts`).
   `runWorkflow` checks every executable node (loop children included;
   annotations, seeded outputs, and out-of-`restrictToStepIds` nodes
   excluded) against the local baseline right after the run row persists,
   and fails the run at t=0 with one structured, recoverable
   `capability-missing:<cap>` error (`WorkflowRunError.code`), plugin
   error/complete hooks fired, zero side effects. Not in `validateWorkflow`
   — validity is a property of the definition, capability of the runner; a
   desktop workflow opened on web must stay "valid". Preflight re-runs on
   resume by design: the resuming device must also hold the caps.

4. **Editor affinity surfacing.** Shared
   `components/workflow/editor/capability-badge.tsx`
   (`useMissingNodeCapabilities` — same math as the preflight) renders
   "unavailable here" badges + capability tooltips in the node search
   sidebar, the command palette, and the inspector header. Display names in
   the `workflows.capabilities` i18n namespace (en + zh-CN).

5. **Trigger device identity.** `WorkflowTriggeredFrom.deviceId?: string`.
   The Rust RPC layer injects `callerDeviceId` from the verified device JWT
   for allowlisted commands (`inject_caller_device_id` in `rpc.rs` —
   overwrites any client-sent value, so it cannot be spoofed); the
   companion `workflow_trigger_manual` arm now records
   `{ source: "api", deviceId }` (previously mislabeled `"ui"`).
   `StartWorkflowFromRemoteInput.deviceId` carries the same for the
   remote-control path.

6. **`device_capabilities_report` RPC.** On every transition to
   `connected`, the mobile shell reports `detectLocalCapabilities()`
   (`lib/companion/capability-reporter.ts`, dedupe on payload, retry on
   reconnect, mounted by the companion boot provider). The desktop
   validates (`isCapabilityId`, capped at 64) and persists onto the
   caller's `pairedDevices` row (`capabilities` +
   `capabilitiesReportedAt`; additive non-indexed columns — no Dexie
   version bump). Deliberately not a `MOBILE_OUTBOUND_COMMANDS` member: a
   capability report is a refreshable snapshot, not queued state.

## Consequences

### Positive

- The orchestrator's failure mode for platform-mismatched nodes moves from
  "executor throws mid-run after side effects" to one structured t=0
  failure with a machine-readable code.
- Authors see device affinity in the editor before pressing Run, using the
  exact math the runtime enforces.
- Run history can answer "which device triggered this" — the audit
  substrate every later placement/handoff layer needs.
- The hub now knows what each paired device can do — the scheduling
  substrate for L1 placement (`runOn: { capability: "camera" }` resolves
  against `pairedDevices.capabilities` + liveness).
- All additive: no schema bumps, no behavior change for
  capability-satisfied workflows, plugin API extension is optional.

### Negative / accepted debt

- Baselines are static per platform; finer-grained probing (camera
  permission actually granted, keyring unlocked) stays with the
  `lib/capacitor` outcome façade at call time. A capability id asserts the
  *facility* exists, not that this call will succeed.
- `WorkflowNodeKind` remains a closed union; plugin kinds still enter via
  `as never` (ADR 0017 debt — widening to `string` + catalog validation is
  an independent project this ADR deliberately did not bundle).
- Unregistered plugin nodes resolve to a catalog stub with no `requires`,
  so they still fail later at registry lookup rather than in preflight.
- `startStepId`-bounded runs preflight the whole graph (conservative); only
  `restrictToStepIds` gets exact scoping.
- The web palette still shows `action.desktop.*` entries (pre-existing
  behavior, now with badges); hiding them is a UX decision deferred to L1.

## Phase plan (P2+)

- **P2 — visibility + human-in-the-loop (implemented):**
  - `workflow://run-status` live frames + `sync://invalidate` publishing
    (first publisher for the channel the mobile event-driven sync has
    subscribed to since ADR-0027) + `workflow://run-terminal` push, all
    riding the `persistRunState` funnel
    (`lib/workflow/runtime/companion-run-events.ts`). Push policy: failed
    always; succeeded/cancelled only when device-triggered; ids+status only.
  - `action.approval.request` node: wake-bus blocking executor with
    event-log checkpoint resume (no duplicate notify, original timeout
    budget), approved/rejected decision handles, notification-center
    Approve/Reject actions, `workflow_approval_list` /
    `workflow_approval_respond` RPCs (control-gated, JWT-injected responder
    identity), and the mobile PendingApprovalsCard.
- **P3 — reverse execution (implemented):** hub-orchestrated remote steps
  over existing plumbing — the broker
  (`lib/workflow/runtime/remote-step-broker.ts`) emits
  `workflow://step-execute` WS frames + ids-only `workflow://step-pending`
  push; the phone's remote-step server executes through the
  `lib/capacitor` outcome façades and answers via the chunked
  `workflow_step_result` RPC (32 KiB slices under the 64 KiB body cap;
  responder identity JWT-verified against the request target). Five node
  kinds shipped: `action.mobile.{camera,scanBarcode,location,share,notify}`
  with hub proxy executors (freshest capable device, pinnable), remote-aware
  preflight (`remoteCapabilityUnion`), and "Runs on phone" editor badges.
  Foreground-first; deferred follow-ups: voice recording (audio payloads
  want a blob relay, not chunked JSON), an OS background-runner path, and
  serving requests over the symmetric WebRTC DataChannel when HTTP/WS is
  down.
- **P4 — run lease & claim contention (implemented):**
  - `WorkflowRunRow.lease` (`lib/workflow/runtime/run-lease.ts`): claimed
    before the first step through one Dexie transaction, heartbeat-renewed
    (TTL/3), released on every terminal path — a second executor backs off
    instead of double-executing, and a terminal-row guard stops resume
    replays from resurrecting soft-cancelled/finished runs.
  - Shared cancel ladder (`cancel-run.ts`) behind both remote surfaces:
    local abort → `cancelRequestedAt` lease signal (the owning executor's
    heartbeat aborts within one beat) → soft-cancel with companion
    fan-out through the P2 run-state funnel.
  - `TeamExternalPickup` grew the structured claimant
    (`{ kind: "external-agent" | "device" | "desktop", id, label }`),
    `targetId` addressing, and a 10-minute claim lease with the contention
    rule: expired claim + still-idle team ⇒ the pickup re-advertises.
  - Deferred with rationale: the symmetric session-handoff envelope +
    share-server blob relay for artifacts is a chat-session feature with a
    cross-service dependency (the deployed share-server), not part of the
    workflow execution core — tracked as its own follow-up.
- **P5 — cloud node:** the ADR-0059 headless brain registers as an
  `always-on` + `headless` device in the same registry; cron/webhook
  placement falls to it when the desktop is off.

Security posture for all phases: PII egress copies the established pattern
(`redactText` outward, `hasNoLeakingPii` for passthrough); headless HITL
follows `resolveGatePolicy` by origin; remote step execution joins the
per-device elevated tier (`control_allow_list` pattern); `keyring:*` refs
are a placement constraint (execute where the secret lives) — secret sync
is a non-goal.

## References

- `lib/platform/capabilities.ts` — vocabulary + baselines
- `lib/workflow/nodes/catalog.ts` — `requires`, `effectiveRequires`, `missingCapabilities`
- `lib/workflow/runtime/capability-preflight.ts` — run preflight
- `components/workflow/editor/capability-badge.tsx` — editor surfacing
- `lib/companion/capability-reporter.ts` + `src-tauri/src/companion_api/rpc.rs:inject_caller_device_id` — transport slice
- ADR 0011 (workflow subsystem), 0017/0034 (plugin extension points),
  0012/0021 (transports), 0005 (remote control), 0059 (headless brain)
