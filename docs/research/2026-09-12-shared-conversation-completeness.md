# Shared conversation and device continuity audit

Date: 2026-09-12

## Architecture retained

Cognia has two complementary conversation planes. Shared conversations use the collaboration service as the authority for membership, ordered events, approvals, queues, and execution leases (ADR-0149). Paired devices delegate room execution to their Host (ADR-0177). Local profiles and local-only conversations retain their existing offline behavior.

This work extends the owning modules. It introduces no alternative conversation store or parallel orchestration engine. Existing concurrent changes in the checkout are outside this audit's ownership.

## Confirmed gaps and repairs

| User path                             | Observed gap                                                                                                        | Repair and regression seam                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Keep several conversations open       | Only the active session owned a live stream; retained panes and other open tabs became stale                        | Each unique open shared binding owns a stable child lifecycle; removing one pane leaves other streams intact        |
| Turn shared chat off                  | Lifecycle read a nonreactive preference and kept existing sockets alive                                             | Reuse useSharedChatEnabled and tear down streams and execution ownership on preference changes                      |
| Discover remote conversations         | Workspace discovery ran only on mount/focus/network changes; one inaccessible session stopped the remaining refresh | Serial discovery repeats 30 seconds after completion, skips hidden/offline work, and isolates individual failures   |
| Revoke membership during connection   | A successful history pull followed by rejected stream authorization retained private projected history              | Purge the scoped projection and event cache on stream 403/404; connection callbacks update existing rows atomically |
| Retry run-lease acquisition           | Server generated a new token while idempotency returned the original lease                                          | Stable client token accompanies the existing operation identity                                                     |
| Heartbeat/release a lease             | Mutations did not bind the lease to the URL session and release lacked holder credentials                           | Enforce session, device, and token binding; expired heartbeat cannot revive a timed-out writer                      |
| Maintain membership                   | PUT could demote an existing Owner despite PATCH's stricter rule                                                    | Apply the same existing-owner restriction to both paths                                                             |
| Send concurrently from devices        | Multiple sends could pass the idle check before asynchronous preparation completed                                  | Reserve admission synchronously per room and release it on failure/cancellation                                     |
| Receive a remote send acknowledgement | Host replied accepted before knowing whether execution could be admitted                                            | Acknowledge actual persisted/admitted work while keeping long generation detached                                   |

Additional repairs extend the same ownership boundaries:

- Ordinary active-session messages use the authenticated human/guest author and user role. Message creation cannot reuse an existing message ID under a different operation to bypass edit permissions. Creator-owned historical import retains its original roles and reuses durable attachment/event identities when retrying uncertain activation or commit responses.
- Suspended startup/recovery is fenced across asynchronous boundaries. A late acquired lease is released with its original device/token and cannot start a new execution.
- Room admission releases the broker lease even if persistence fails or cancellation occurs before streaming. Drained steering bubbles become applied only after admission; a refusal leaves a recoverable failed bubble. This includes companion drains after approval or elicitation.
- Remote room edit/regenerate rejection becomes a session diagnostic. Desktop clients controlling another Host use the same remote room path as paired phones/web clients.
- A durable `session_mark_read` command carries the observed Host watermark. The Host preserves newer unread activity; pending client reads suppress only snapshots they actually cover. Account and target switches fence the write.

## Industry inputs

Matrix v1.15 specifies client transaction identifiers for distinguishing retransmission from new work, and incremental synchronization checkpoints for recovering durable history. These inform stable operation/lease identities and applied-cursor recovery here; Cognia keeps its existing transport and schema. [Matrix Client-Server API](https://spec.matrix.org/v1.15/client-server-api/)

Slack separates persistent message state from real-time event delivery. This supports retaining Cognia's history pull alongside live notification streams and adding bounded discovery for conversations without an open stream. [Slack real-time messaging](https://slack.engineering/real-time-messaging/)

## Verification boundaries

Regression tests target the public synchronization controller, mounted lifecycle, server authority/store, and Host room admission. Browser mock suites already exist at tests/e2e/web/shared-chat.spec.ts and tests/e2e/mobile/shared-chat.spec.ts; they are distinct from real paired-device or deployed-service evidence.

During this run the filesystem exhausted free space. Jest failed with ENOSPC in HasteMap/transform-cache writes. Only this task's Rust incremental cache was removed. Full repository coverage, a fresh static export, native/device E2E, and deployed PostgreSQL validation are not established by focused test results.

Recorded validation:

| Check                                                                               | Result                                                                                                                                               |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared synchronization Jest suite                                                   | 61 tests passed; 98.92% lines, 93.70% branches, 100% functions                                                                                       |
| Shared lifecycle Jest suite                                                         | 13 tests passed; 100% lines, 92.95% branches, 100% functions                                                                                         |
| Collaboration Rust library                                                          | 172 tests passed, including lease ownership and import replay                                                                                        |
| Shared conversion                                                                   | 37 tests passed; 99.54% lines, 90.69% branches, 100% functions; activation/attachment commit response-loss recovery                                  |
| Shared client contract                                                              | 38 tests passed                                                                                                                                      |
| Shared run coordinator                                                              | 40 tests passed; 95.48% lines, 90.22% branches, 100% functions                                                                                       |
| Device and room focused suites                                                      | 13 suites passed; 449 tests passed, one independently reproduced baseline provider-fallback case excluded by command-line filter (no permanent skip) |
| Companion queue admission follow-up                                                 | 2 suites, 125 tests passed; pending acceptance, refusal and transport rejection preserve correct bubble state                                        |
| Companion generation and consistency                                                | Passed; 694 commands and 101 routes                                                                                                                  |
| Expanded background-tab browser regression                                          | Passed: second participant creates/views a private conversation; the still-open shared conversation receives exactly one new durable message row     |
| Existing desktop shared-chat browser scenarios                                      | 4 passed on the current Next.js development server                                                                                                   |
| Root typecheck through `rtk proxy pnpm typecheck`                                   | Failed with 61 diagnostics outside this change; zero diagnostics in the owned paths on the final run                                                 |
| Full `pnpm test:coverage --jobs 1 --workers 1 --out coverage/shared-audit-20260912` | Started; plugin context namespace assertion failed; stopped after this confirmed unrelated failing gate                                              |
| `pnpm audit:e2e-governance`                                                         | Failed on undeclared runtime skip at tests/e2e/mobile/remote-session-control.spec.ts:131                                                             |

Final device boundary coverage ran six suites with 64 passing tests. Each selected file passed its 90% lines/branches/functions gate: `lib/db/session-state.ts` 100%/95.38%/100%; `lib/sync/handlers/session-state.ts` 100%/100%/100%; room write handlers 100%/97.70%/100%; production dependencies 100%/96.66%/100%; store sinks 99.11%/100%/100%; room shell 100%/100%/100%. Together with the disjoint companion queue follow-up, the final focused device run covers eight suites and 189 passing tests; these overlap the earlier broader device run and must not be added to it as unique tests.

The large pre-existing CollabClient file remains below its whole-file coverage threshold. Focused passing tests do not establish the repository-wide 90% requirement.

## Compatibility

Deploy the collaboration client/server changes together. Older clients lacking the required release credentials fail closed and their leases expire normally. The new read command is advertised through the existing Host feature/command manifest and uses the existing durable outbound pipeline. No database schema migration is required.
