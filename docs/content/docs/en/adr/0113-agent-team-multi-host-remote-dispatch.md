---
title: "ADR-0113: AgentTeam Multi-Host Remote Dispatch"
description: Distribute durable AgentTeam children to authenticated Cognia workers while preserving the existing task, run, review, workspace, and delivery authorities.
---

# ADR-0113: AgentTeam Multi-Host Remote Dispatch

## Status

Accepted for dark launch (2026-08-12). Remote dispatch remains disabled by default.

## Context

AgentTeam durable-v2 already owns child admission, attempts, checkpoints, evidence, decisions, retrospectives, and Git delivery. `ExecutionRun` owns the cross-runtime run journal and bindings. `ExecutionBroker` owns admission on each execution host. Task Workspace owns isolated Git workspaces, SecurityStore owns authenticated devices and grants, and Fleet owns the public operations projection.

The missing capability is bounded: a headless brain cannot select two concurrently connected execution hosts, dispatch child turns through the existing Agent RPC v2 protocol, and recover those turns without weakening the existing authorities. Creating a generic task, queue, lease, review, lineage, or fleet subsystem would duplicate committed behavior and is rejected.

## Decision

1. **The brain remains authoritative.** `AgentTask`, AgentTeam durable-v2 rows, `ExecutionRun`, action review receipts, decision/evidence records, and the delivery graph remain on the brain. Workers execute turns and return protocol events; they do not settle team state or publish delivery independently.

2. **Agent RPC v2 is the only runtime protocol.** `session/create` accepts an additive `commandId` and optional `HandoffEnvelope`. The envelope has one canonical definition in `@cognia/agent`; `@cognia/agent-config-types/handoff-envelope` is a compatibility re-export. Remote handoff rejects caller-controlled `cwd` and requires the `worker-dispatch-v1` capability.

3. **Authenticated worker identity wins over self-reporting.** `cognia-agent worker enroll` exchanges a one-time enrollment for a Companion device credential. `worker connect` uses DPoP-authenticated HTTP to mint a short-lived, single-use socket ticket, then attaches to `/ws/worker`. Public PKI uses normal CA validation; LAN self-signed deployments pin the peer X.509 SPKI SHA-256 fingerprint without globally disabling TLS validation. Every reconnect remints a ticket and recreates the socket/RPC streams. The front door derives `hostRef` from the authenticated device and requires the narrow `agent.worker` grant. Management DTOs return that derived reference instead of asking clients to reconstruct it.

4. **The bridge remains opaque.** Bridge protocol v3 adds versioned worker attach, frame, and detach envelopes. It multiplexes newline-delimited Agent RPC frames and applies the existing frame and backpressure ceilings; it does not parse prompts or persist task state. Handshake timeout is 10 seconds, heartbeat interval is 25 seconds, and a worker is offline after 90 seconds without activity.

5. **Workers advertise one canonical execution profile.** `AgentWorkerManifestV1.executionProfile` reports the backend adapter, runtime adapter, model bindings, deployment references, and canonical capabilities derived by `resolveWorkerExecutionProfile()`. The resolver clamps theoretical runtime capability to the selected CLI backend. New workers must advertise this profile; legacy manifests remain readable but cannot enter P0 placement. Manifest type, schema, and guard share one Valibot authority.

6. **Repository paths remain device-local.** P0 supports one pre-bound Git repository per child and never clones automatically. `cognia-agent worker bind` records the local source in Task Workspace's existing SQLite database. The brain sees only a stable `repository:<projectId>:<repositoryId>` reference. Binding and execution validate Workspace Trust, Git root identity, symlink containment, Registry ownership, and Task Workspace availability.

7. **Placement consumes the frozen execution spec.** `TeammateExecutionBinding.executionTarget` is `colocate`, `auto`, or `pinned`. Placement checks runtime, model, deployment, active credential reference, canonical capabilities, Task Workspace, repository binding, sandbox, and capacity. After `auto` selects an authenticated host, the resolver-owned rebind helper updates `hostRef` and recomputes the fingerprint; callers never mutate a frozen spec directly.

8. **No second scheduler or lease authority is introduced.** `DurableTeamCoordinator.withChildAdmission` retains team admission. The selected worker executes through its local `ExecutionBroker`. Dispatch ownership is stored as optional compare-and-set fields on the existing `AgentTeamChildRun`: a 60-second lease, renewed every 20 seconds. `commandId` equals `dispatchLeaseId`, so duplicate session creation returns the original receipt.

9. **Events project into existing durable records.** Remote `eventId` values advance `lastRemoteEventId` transactionally. Accepted events feed durable dispatch capture, trajectory, checkpoints, evidence, usage, the `ExecutionRun` journal, and delivery graph. Duplicate events and terminal outcomes cannot settle usage, evidence, or delivery twice.

10. **Pause and recovery are checkpoint-gated.** Pause stops new admission, keeps consuming events, waits for the current turn to become naturally idle, then writes the brain-owned checkpoint. It does not abort or ask the worker to snapshot. Unsafe effects become `needs_input`, and terminal children cannot be overwritten by a late pause. Resume reschedules non-terminal work without `session.open()`; that method is reserved for disconnect/restart recovery, which opens the original session and replays from `lastRemoteEventId`. Terminate remains abort, idle wait, then close.

11. **Fleet remains the public operations surface.** `fleet_get_snapshot` and `fleet://update` add optional host readiness/reason and managed-session lineage fields for backward compatibility. Fleet and Settings display enrollment, identity, online state, capacity, profile incompatibility, and prerequisites using existing settings primitives. Remote selectors activate only when resolver v2, remote dispatch, Task Workspace, and a placement-ready profile are present; a saved offline pin remains visible.

12. **Rollout is reversible.** `agentTeamRemoteDispatch` is off by default and requires resolver v2 plus Task Workspace. Disabling it stops new remote dispatch while existing sessions may still deliver events and accept controls. Revoking `agent.worker` immediately disconnects the device and sends affected children through the same checkpoint safety decision. All child and Fleet fields are optional, so rollback requires no destructive migration.

## Consequences

- Two one-slot workers can run two admitted children concurrently without changing team concurrency semantics.
- A disconnected pinned worker produces an inspectable queued child instead of local fallback.
- Credentials and absolute repository paths remain on the worker that resolves them.
- Recovery decisions are evidence-based and operator-visible.
- Older clients, workers, AgentTeam records, and Fleet snapshots remain readable.
- P0 does not add multi-user work items, automatic clone, multi-root children, a PostgreSQL task authority, or deployment operations for AgentTeam work.

## Verification

Contract tests cover old/new client-host compatibility, capability errors, `commandId` deduplication, event replay, and package consumption. Rust tests cover enrollment replay, grant separation, cross-tenant refusal, ticket replay, revocation, frame limits, heartbeat expiry, and authenticated `hostRef`. Task Workspace tests cover Git identity, trust, symlink escape, missing bindings, and concurrent isolation. AgentTeam tests cover stable placement, capacity waits, pre-model failures, lease compare-and-set, duplicate events/results, safe migration, unsafe recovery, and control mapping. Product tests cover desktop, web, and mobile host grouping and recovery controls. Release smoke uses real Claude Code and Codex workers but CI uses deterministic fake runtimes and temporary Git repositories.

## Operations

The deployment and rollback procedure is maintained in `docs/runbooks/agent-team-remote-dispatch.md`.

## References

- ADR-0022: `docs/content/docs/en/adr/0022-agent-team-runtime-hardening.md`
- ADR-0059: `docs/content/docs/en/adr/0059-cloud-deployment-headless-brain.md`
- ADR-0086: `docs/content/docs/en/adr/0086-task-scoped-resource-workspaces.md`
- ADR-0090: `docs/content/docs/en/adr/0090-unified-agent-execution-and-gateway-compatibility.md`
- ADR-0111: `docs/content/docs/en/adr/0111-managed-workspace-registry-and-bundle.md`

## 2026-08-20 amendment — one prerequisite, not three

Decision 12 gated remote dispatch behind `agentTeamRemoteDispatch` **plus**
`agentExecutionResolverV2` **plus** `developer.taskWorkspace`, all three off by
default. Two of those are no longer toggles: the unified resolver is the only
execution path (ADR-0090 Phase 9) and Task Workspace isolation is GA. Remote
dispatch is therefore one flag, still off by default, and
`isAgentTeamRemoteDispatchEnabled()` takes no arguments.

The per-worker check is unchanged and remains the real fail-closed boundary:
a worker that does not advertise `taskWorkspace.enabled` is refused placement
with `task_workspace_unavailable`.

