# Evidence ledger: person brain stdout lag

- Status: verifying
- Lane: standard
- Created: 2026-10-25
- Updated: 2026-10-25
- Related: ../plans/2026-10-20-multi-user-organizations-permissions-and-rollout.md §9b.8; ADR-0059; ADR-0127

## Original request

> Make person-brain stdout relay survive event-bus lag and remove per-device purge invalidation fan-out while preserving partition audiences. Add in-file Rust tests and respect the shared tree and low disk constraints.

## Knowledge

| ID  | Statement                                                                                               | State       | Basis                                                                                                  | Depends on |
| --- | ------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ | ---------- |
| O1  | A brain uses the shared 256-frame broadcast; its socket closes on Lagged.                               | Verified    | event_bus.rs and ws.rs; regression on 2026-10-25 failed with Lagged(59753).                            | -          |
| O2  | One purge invalidation creates one frame per device plus the brain.                                     | Verified    | person_chat.rs; regression on 2026-10-25 produced 601 frames for 600 devices.                          | -          |
| H1  | An unrelated burst can evict stdout before the brain consumes it.                                       | Verified    | O1 regression interleaves JSON fragments with bursts exceeding both channel and replay capacities.     | O1         |
| H2  | Replay-ring recovery alone guarantees stdout continuity.                                                | Invalidated | Ring capacity is 10,000 and ephemeral publications are excluded; it cannot guarantee arbitrary bursts. | O1         |
| G1  | A connected person brain receives its own process output once and in order despite unrelated bursts.    | Agreed      | User request, 2026-10-25.                                                                              | -          |
| C1  | Keep person_connection_visible and person_partition::event_visible at delivery and replay.              | Verified    | Existing ws.rs predicate and audience tests; user requirement.                                         | -          |
| C2  | Preserve shared edits, avoid whole-file formatting, reuse incremental builds, check disk before builds. | Observed    | User request and CLAUDE.md; initial df reports 1.6 GiB free.                                           | -          |

## Problem frame

Protect the person brain's connected process-output relay from bounded broadcast eviction (G1, O1). Use a partition-filtered non-lossy live queue and retain the existing replay handshake and delivery predicates (C1). Publish replayable invalidations once per partition (O2). This does not promise recovery of process stdout after a real socket failure or Host restart.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                 |
| ------------ | ------ | --------------------------------------------------------------------------- |
| scale        | medium | Event bus, WebSocket selection, person publication, and bridge publication. |
| technical    | medium | Atomic replay/live handoff and ordering under concurrent publication.       |
| coupling     | medium | Keep existing wire frames, ordinary device broadcast, and replay retention. |
| requirement  | low    | Explicit stdout continuity and partition constraints.                       |
| verification | medium | Deterministic burst tests plus P6f live smoke; rig is currently shared.     |
| risk         | medium | Cross-person disclosure or duplicate stdout would break privacy or parsing. |

## Risks

| ID  | Risk (impact)                                                       | Severity | Source                 | Claim                                                                                                   | Refuted by                                                                 |
| --- | ------------------------------------------------------------------- | -------- | ---------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| R1  | Missing or duplicate stdout corrupts a turn.                        | high     | O1                     | Live person relay survives bursts and hands replay to live exactly once.                                | Reassembled JSON differs, ordering changes, or a Lagged error occurs.      |
| R2  | Partition queue leaks frames across persons or device reassignment. | high     | C1                     | Queue filters partition and destination; existing delivery checks remain.                               | Operator, another brain, or reassigned device receives a protected frame.  |
| R3  | Device count multiplies invalidation traffic.                       | medium   | O2                     | Each invalidation/revision emits one replayable partition frame.                                        | Frame count increases with device count or replay loses invalidations.     |
| R4  | A stalled brain accumulates its own queued output.                  | medium   | Non-lossy queue design | Unrelated partitions and device-targeted copies cannot grow its queue; dropping the socket releases it. | Unrelated frames enter the queue or closed receivers retain queued output. |

## Verification obligations

| ID  | Risk           | Method                                                    | Independence   | Evidence                                                                                                                                                                                                                                                                                                                              | Coverage                                                                                                                              | Status  |
| --- | -------------- | --------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1, R4         | Bus burst, concurrency, filtering and cleanup tests.      | tool           | `cargo test -p cognia-companion-bus --lib --quiet`: 168 passed, 1 ignored. Red regression failed with Lagged(59753).                                                                                                                                                                                                                  | More than 10,000 unrelated frames, split fractional JSON, 600 own frames, atomic handoff, ephemeral paths.                            | passed  |
| V2  | R2, R3         | Companion socket, person audience and bridge tests.       | tool           | `cargo test -p cognia-companion --lib person_ --quiet`: 28 passed; `ws::tests::`: 29 passed; `ws_bridge::tests::`: 34 passed (overlapping filters). Red invalidation regression: 601 versus 1. Real TCP socket test passes with person JWT, subscription and batched stdout.                                                          | Owning brain, operator, other person, reassigned device, replay, bridge envelope, actual event socket.                                | passed  |
| V3  | R1, R2, R3     | Focused Rust tests, clippy, diff and architecture checks. | tool           | Tests above pass; `pnpm audit:rust-architecture`: 70 crates layered, 2 baselined findings; scoped `git diff --check` passes. `cargo clippy -p cognia-companion-bus --lib --no-deps -- -D warnings` passes. Strict Companion Clippy fails on 22 findings on unchanged lines; diagnostics: `.cache/person-brain-stdout-lag-clippy.log`. | Changed crates and call-site wiring; no frontend behavior changes.                                                                    | blocked |
| V4  | R1             | P6f persons tier with deepseek / ark-deepseek-v4.1-flash. | real-env       | Not run on the changed Host: disk fell from 1.6 GiB to 538 MiB free, while the existing Host executable alone is 577 MiB. An isolated Host plus relink/dependencies would exceed the remaining build margin. Existing shared rig was left running.                                                                                    | Real member turn through Host and proxy at 127.0.0.1:8787/v1 remains unverified for this patch.                                       | blocked |
| V5  | R1, R2, R3, R4 | Independent scoped Rust preflight review.                 | fresh-reviewer | `tauri-rust-reviewer` reviewed the four Rust diffs twice, including the actual TCP test: no actionable findings; own-output backlog caveat retained below.                                                                                                                                                                            | Locks, publication ordering, replay/live registration, person JWT wiring, audience predicates, receiver cleanup, server-task cleanup. | passed  |

## Decisions

| ID  | Date       | Decision                                                                                                                                                                                         | Action    | Based on       | Reversal trigger                                                         |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | -------------- | ------------------------------------------------------------------------ |
| D1  | 2026-10-25 | Add non-lossy queues only for authenticated person-brain sockets; serialize subscription snapshot with publication. Ordinary device streams keep broadcast. H2 is ruled out.                     | implement | O1, G1, C1, C2 | A replay/live race, privacy failure, or unacceptable own-output backlog. |
| D2  | 2026-10-25 | Use one partition-stamped replayable invalidation/revision; live replies remain ephemeral. Extend existing modules; only this evidence record and the required release changeset need new files. | implement | O2, C1, C2     | A consumer requires an individual invalidation destination.              |

## Residual risks

| ID  | Residual                                                                          | From | Why still open                                                                                                                                   | Next action                                                                                                                                                    | Status |
| --- | --------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Non-lossy queues can grow with a person's own output while its socket is stalled. | R4   | Reliability trades bounded eviction for retaining undelivered own frames. A blocked socket send can outlast heartbeat/idle checks.               | Filtering and receiver-drop cleanup pass; a future bounded-storage or upstream-backpressure policy would need to preserve stdout.                              | open   |
| X2  | Real-provider P6f run on the changed Host is pending.                             | V4   | Insufficient disk headroom to build a separate Host; the shared existing rig remains untouched.                                                  | Free build space, build `cognia-server --features container-exec`, then run the persons tier with deepseek / ark-deepseek-v4.1-flash against an isolated Host. | open   |
| X3  | Strict Companion Clippy remains blocked by existing findings.                     | V3   | 22 findings include result_large_err, useless_asref, too_many_arguments, and type_complexity on unchanged lines; unrelated edits were preserved. | Resolve those findings in their owning tasks, then repeat the strict command.                                                                                  | open   |

## Outcome

| ID  | Signal                                                                                                         | How / when measured                                                             | Result                                                                                                               | Status  |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| M1  | Connected member event socket delivers intact stdout after an unrelated burst; invalidation count is constant. | Actual person-JWT TCP socket, bus burst and purge regression tests, 2026-10-25. | Split fractional JSON reconstructs exactly; sequences match; 600 device destinations produce one invalidation frame. | met     |
| M2  | Real-provider member turn settles through the changed Host.                                                    | P6f persons tier after an isolated Host build.                                  | Not measured; see X2.                                                                                                | pending |
