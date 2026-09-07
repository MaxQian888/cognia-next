---
title: "0103 — Cross-host session handoff"
description: "A two-phase, single-writer protocol for continuing a Cognia session on another trusted Host without transferring ambient authority or absolute paths."
---

# ADR 0103 — Cross-host session handoff

**Status:** Accepted  
**Date:** 2026-08-28  
**Related:** [ADR-0062](./0062-external-agent-session-import), [ADR-0116](./0116-host-authoritative-session-state), [ADR-0136](./0136-cross-device-placement), [ADR-0149](./0149-a-person-is-not-a-device), [ADR-0153](./0153-the-host-obtains-the-confirmation)

## Context

A synchronized transcript is not a transferable execution session. A continuation also needs a model and credential on the destination, a resolvable Workspace, attachments, and a decision about which copy may accept writes. Copying a session first and resolving ownership later can produce two writable histories. Transferring a native runtime handle or host paths is neither portable nor safe.

## Decision

Handoff is a ticketed two-phase protocol identified by the `thread-handoff-v1` capability. Desktop Host, Cloud Host, CLI, and standalone mobile may own a session. Paired browser/mobile surfaces remain controllers.

Each ticket is stored twice in Dexie under `[ticketId+role]`, once for `source` and once for `target`. Both use the same five states: `preparing`, `frozen`, `accepted`, `committed`, and `aborted`. Delivery reuses `hostDispatchQueue` with the `thread-handoff` domain.

The protocol preserves a single writable copy:

1. The source completes its history, computes a digest, persists its ticket and `handoffLock`, then freezes the session.
2. The target preflights provider, model, credential, Workspace, protocol, and attachments. It imports the canonical session as a read-only `accepted` copy.
3. After an authenticated accepted receipt, the source commits itself permanently read-only.
4. Only after receiving the source commit proof may the target become writable and `committed`.

Zero writable copies are permitted during failure recovery; two writable copies are never permitted. `accepted` cannot time out into write access. A coordinated abort may restore a frozen source only after proving that the target never accepted, or that the accepted read-only copy was deleted. Otherwise the ticket enters operator review.

All session mutations pass one write guard, including messages, run continuation, title and metadata changes, Workspace moves, branching, and deletion. Checking only the move path is insufficient.

## Portability and authority

Attachments use the existing chunk transport. Absolute paths never cross hosts. Native runtime handles and Host tools do not transfer; when they cannot be restored, the destination starts a transcript-seeded continuation. Historical permission grants do not transfer and destination tools ask again.

Standalone mobile keeps local Dexie and BYOK inference. It may receive handoff tickets only after Companion pairing advertises `thread-handoff-v1`; it does not install the full HostState mirror. Reconnection resumes from `thread_handoff_status`.

The six Companion operations are `offer`, `preflight`, `accept`, `commit`, `abort`, and `status`. `accept` and `commit` require `host.admin` plus step-up. Requests are idempotent by ticket, role, and state; illegal transitions return conflict.

## Kill switch

Removing `thread-handoff-v1` from the negotiated capability disables new offers and ownership changes while leaving status and recovery data readable. This is both the protocol version signal and the rollout kill switch.


## Structured continuation and recovery (2026-09-07)

New offers additionally require `thread-handoff-structured-v1`. This prevents an older target that flattens canonical messages into text from acknowledging a structured handoff. The existing canonical codec preserves reasoning, files, and tool results; an unsupported part blocks export rather than disappearing. Native handles remain provenance, while cross-host continuation is explicitly contextual. Incomplete historical tool calls become interrupted history and do not execute automatically.

A manifest is computed from actual canonical attachment bytes. Paired standalone devices fetch missing media through the authenticated source-session binary route. Remote Hosts receive the same bytes through the existing resumable attachment uploader; target-side preflight verifies SHA-256, length, and media type and materializes permanent media references. Canonical URIs and the sequence digest remain stable across staging. Every carriage mode must be locally verifiable before acceptance.

Remote Host handoff is an explicit action over an isolated configured Host transport, without changing active routing. It obtains the destination's own admin consent, accepts a locked target, commits the source, and then unlocks the target. If the last response is lost, retry completes the target commit without importing another conversation. Both import paths write the target lock atomically with the transcript; canonical digest and attachment-manifest mismatches are refused before import.

Server-authoritative shared conversations cannot use portable-copy handoff: changing their executor must keep the existing collaboration identity and use its authorized execution lease. History ownership caches are scoped to the account database, runtime target, and routing generation, and invalidated on connection changes and committed handoffs. In-flight responses from an obsolete scope cannot publish ownership or persist history into a newly selected account.
