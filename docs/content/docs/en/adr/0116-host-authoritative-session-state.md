---
title: "ADR-0116: Host-authoritative cross-surface session state"
description: "AHP-inspired ordered state channels above Agent RPC v2"
---

# ADR-0116: Host-authoritative cross-surface session state

- Status: Accepted. The `migrationStage` rollout ladder was removed on 2026-08-20 — HostState is unconditional (see the amendment at the end).
- Date: 2026-08-14

## Context

Cognia already has one runtime protocol (Agent RPC v2), one remote transport
abstraction, one replayable Companion EventBus, target-scoped databases, table
sync, a durable client queue, and a standalone TUI JSONL store. Web, Mobile,
Desktop, headless, and TUI nevertheless lacked one ordered owner for shared
session intent. Direct runtime calls plus table invalidation could race, repeat
a turn after reconnect, or overwrite a newer draft.

Microsoft's Agent Host Protocol demonstrates useful concepts—named channels,
snapshot cuts, ordered actions, optimistic reconciliation, and protocol-version
negotiation. Its implementation is still evolving, so Cognia adopts those
concepts without adding an AHP dependency or a second runtime protocol.

## Decision

The active Desktop/headless Host is the sole authority for each live session.
`HostStateProtocolV1` is a coordination layer above Agent RPC v2:

- `cognia://target/{targetId}/sessions` carries bounded session summaries.
- `cognia://target/{targetId}/sessions/{sessionId}` carries the shared draft,
  queue, active-turn and decision state, and transcript revision.
- Client actions are durably queued before optimistic projection and carry
  account, target, opaque Host identity, Host generation, client sequence,
  action id, and optional base revision.
- The Host commits the materialized projection, existing business repository,
  and semantic receipt in one Dexie transaction. Runtime work is dispatched
  afterward with the same action id; pending dispatch and broadcast rows are
  recoverable.
- A 10-second heartbeat and 30-second lease fence stale Host generations.
- Clients subscribe to the existing `host-state://action` EventBus topic before
  requesting snapshots. The EventBus carrier sequence remains the transport
  replay cursor; `{hostGeneration, hostSeq}` is the state-order invariant.

## Reused ownership

This decision does not introduce another socket, EventBus, RPC runtime, target
registry, queue runner, React provider, or TUI session store. It extends:

- `Transport.call/subscribe`, Companion WS/RTC replay, and `BridgeTransport`;
- `mobileOutboundQueue` as the attached-surface action outbox;
- `RuntimeTargetRegistry` and account/target database activation;
- existing session, message, draft, transcript, and tombstone repositories;
- the existing Web/Mobile boot providers and chat store projection;
- the CLI endpoint file and dev-token validator for local TUI attach.

Agent RPC v2 remains the owner of provider, turn, tool, permission, and runtime
event lifecycles. Historical transcript pages remain outside HostState
snapshots. WebDAV and Companion table sync remain data replication mechanisms,
not live-session authorities. Standalone TUI remains local JSONL and never
silently merges into an attached session.

## Compatibility and rollback

Hosts advertise `session.state-sync@1` in `HostFeatureManifestV2`. Missing
capability means legacy table sync/direct RPC. Rollout is target-scoped through
`legacy-authoritative`, `shadow`, `hoststate-read`, `hoststate-authoritative`,
`legacy-projection-only`, and `retired` stages. Disabling the feature stops new
HostState submissions while preserving pending outbox rows and the always-kept
legacy repositories. No destructive reverse migration is required.

## Consequences

Duplicate transport delivery becomes safe through the existing RPC cache plus
the longer-lived semantic ledger. Revision conflicts and permanent rejection
remain visible instead of disappearing on refresh. The cost is a durable
ledger, snapshot projection, lease recovery, and explicit compatibility period.
Snapshots are capped at 512 KiB and exclude device-local UI state, secrets,
local paths, attachment bytes, and full transcript history.

## 2026-08-20 amendment — the migration ladder is removed

`HostStateMigrationStage` had six values and `hostStateMigrationStageAllowsWrites`
admitted only three of them. Nothing in production ever passed
`start({ migrationStage })`, so every host stayed on the default
`legacy-authoritative` and `commitHostStateAction` refused every write with
`host_state_not_authoritative`. All four client shells checked the stage before
routing and therefore took the legacy table-sync path permanently — while
`host_feature_manifest` advertised `session.state-sync@1` unconditionally.

The ladder, the write gate, the `migrationStage` wire field and the four client
guards are gone. Authority is what it always actually was: the lease plus
`hostGeneration`. Compatibility is preserved by omission — an older client
reading an absent `migrationStage` gets `undefined`, its own
`hostStateMigrationStageAllowsWrites(undefined)` returns false, and it falls back
to legacy table sync exactly as before.

`HOST_STATE_PROTOCOL_VERSION` stays 1; the historical Dexie `version(168)` index
still names `migrationStage` because migration history is immutable, and rows
written from now on simply do not carry the property.

