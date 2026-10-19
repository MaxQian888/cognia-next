# Remote Host delivery and crash recovery audit

Date: 2026-10-19, Asia/Shanghai. Scope: client outbox, physical Host persistence, RPC receipts, HostState authority, runtime dispatch, WorkSubmission integration, attachments, recovery controls, and delivery failures. This is a source audit of the current shared worktree; adjacent concurrent changes are outside ownership. No source code was changed. This extends the [steer/queue audit](./2026-10-19-steer-message-queue-audit.md); official Codex comparison remains in the [release research](./2026-10-19-codex-steer-queue-updates.md).

## Assessment

Remote chat submission has substantial durability machinery: atomic HostState receipts, persisted queued messages, fenced writer generations, runtime-correlated operation status, startup redrive, and a second encrypted WorkSubmission ledger. It is stronger than an in-memory UI queue. However, those two recovery paths do not consistently share identity or replay-safety decisions. Existing passing tests validate the pieces separately and leave important crash boundaries untested.

The highest-priority gaps are:

1. A duplicate message accepted under a new action ID returns the old WorkSubmission receipt, but dispatch still addresses the new action-derived submission ID and can fall back to a new send.
2. HostState redrive reclaims expired WorkSubmissions without the outbox runner's observed-effect safety check or takeover-abort handling.
3. A dispatch failure escapes the HostState submit call after the semantic action is committed; the service has no periodic retry loop. The production RPC layer caches failures, so a same-key retry within receipt retention can replay the error without reaching this durable failed row.
4. Recovery runs before the writer heartbeat starts, and orphan settlement runs after redrive without excluding newly restarted work.

These are source-level findings, not claims of an observed production double execution. The lower runtime command ledger is an in-memory bounded cache; it does not establish crash-proof execution deduplication. Client and runtime findings, physical storage guarantees, and a complete failure matrix are added below.

## Owning stores and identities

| Store/identity                    | Actual role                                                                                         | Evidence                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hostStateMeta`                   | Singleton writer lease, generation, ordered host sequence                                           | [lease acquisition](/Users/bytedance/Project/cognia-next/lib/sync/host-state-store.ts:138)                                                                     |
| `hostStateChannels`               | Persisted confirmed session/index projection, including draft, queue, operations and runtime status | [row definitions](/Users/bytedance/Project/cognia-next/lib/sync/host-state-store.ts:50)                                                                        |
| `hostStateActions`                | Semantic receipt plus retained action payload; dispatch/broadcast/index-summary obligations         | [action row](/Users/bytedance/Project/cognia-next/lib/sync/host-state-store.ts:65)                                                                             |
| `[hostGeneration+actionId]`       | HostState duplicate identity, scoped to one generation                                              | [schema](/Users/bytedance/Project/cognia-next/lib/db/schema.ts:864), [duplicate lookup](/Users/bytedance/Project/cognia-next/lib/sync/host-state-store.ts:438) |
| `chat:{sessionId}:{messageId}`    | WorkSubmission work identity across local and attached-client arrival paths                         | [Host adapter](/Users/bytedance/Project/cognia-next/lib/work-submission/host-adapter.ts:14)                                                                    |
| `work:hoststate:{actionId}`       | Host-derived submission ID; different from message identity                                         | [ID constructors](/Users/bytedance/Project/cognia-next/lib/work-submission/host-adapter.ts:45)                                                                 |
| `actionId` as runtime `commandId` | Correlates enqueue/steer/abort/permission commands with runtime deduplication                       | [dispatcher](/Users/bytedance/Project/cognia-next/lib/sync/host-state-service.ts:179)                                                                          |

`hostDispatchQueue` is a different Host-to-target workflow dispatch mechanism. Its bounded backoff, leases and terminal retention must not be attributed to the HostState chat-action ledger merely because both names contain “Host.” [Separate queue](/Users/bytedance/Project/cognia-next/lib/db/host-dispatch-queue.ts:14).

## Confirmed delivery flow

### 1. Authority and acceptance

Production desktop/headless command routing lazily creates a HostState service, awaits `start()`, then reuses it for matching account/target/host scope. Start acquires the persisted lease; the default TTL is 30 seconds and heartbeat interval 10 seconds. A new owner/generation refreshes session metadata while retaining durable runtime/draft state. [Production wiring](/Users/bytedance/Project/cognia-next/lib/companion/desktop-write-source.ts:917), [lease constants](/Users/bytedance/Project/cognia-next/lib/sync/host-state-store.ts:46), [generation refresh](/Users/bytedance/Project/cognia-next/lib/sync/host-state-store.ts:178).

Submit validates closed shape, scope, caller grants, controller ownership for live intents, attachment references, and business preconditions. Authorization refusals do not append ledger rows. The store transaction commits the channel mutation, action receipt, host sequence and business projection together. For `message.enqueue`, that includes the user-message row and draft deletion. Runtime dispatch happens afterward. [Submit checks](/Users/bytedance/Project/cognia-next/lib/sync/host-state-service.ts:1028), [transaction](/Users/bytedance/Project/cognia-next/lib/sync/host-state-store.ts:392), [message projection](/Users/bytedance/Project/cognia-next/lib/sync/host-state-store.ts:1176).

An existing action returns its original receipt rather than applying the mutation again. `payloadDigest` is stored, but this duplicate branch does not compare the new payload against it. HostState itself therefore assumes an immutable action ID; an outer transport may impose stricter payload checking. [Duplicate branch](/Users/bytedance/Project/cognia-next/lib/sync/host-state-store.ts:438).

### 2. Dispatch and acknowledgments

The accepted mutation records an operation with status `accepted`. `processRow()` dispatches pending/failed rows, marks the private ledger dispatch completed, then publishes an operation status. Enqueue becomes `dispatching`; steer/follow-up/abort/decision answers become `acknowledged` when the dispatch call returns. Runtime queue `accepted` acknowledges the exact enqueue action, `delivered` dequeues it, and `dropped` removes it and marks failure. “Accepted by Host,” “handed to runtime,” and “acknowledged by runtime” are distinct facts. [Action mutations](/Users/bytedance/Project/cognia-next/lib/sync/host-state-service.ts:1805), [dispatch state transition](/Users/bytedance/Project/cognia-next/lib/sync/host-state-service.ts:1294), [runtime queue projection](/Users/bytedance/Project/cognia-next/lib/sync/host-state-service.ts:1568).

The reducer protects an already acknowledged operation against a late `dispatching` update. Failed operations may advance again after a Host retry. [Reducer](/Users/bytedance/Project/cognia-next/packages/agent-config-types/src/host-state.ts:1254).

On dispatch exception, the Host durably marks `dispatchState=failed`, attempts to publish operation failure, then rethrows. This leaves the action durable while the submit RPC fails and returns no normal per-action receipt. Earlier successful actions in the same batch may already have committed. [Failure handling](/Users/bytedance/Project/cognia-next/lib/sync/host-state-service.ts:1317), [submit call boundary](/Users/bytedance/Project/cognia-next/lib/sync/host-state-service.ts:1119).

### 3. WorkSubmission integration

Enqueue first attempts encrypted durable WorkSubmission acceptance, claims dispatch ownership, and starts a lease heartbeat. Production assembly prepares transcript/runtime options, binds them as frozen execution context, then calls `sendPrompt` with the action ID. After handoff it marks the WorkSubmission started. Attachment staging is consumed only after the runtime call returns. [Integration](/Users/bytedance/Project/cognia-next/lib/sync/host-state-service.ts:192).

This is deliberately fail-open: acceptance exceptions are logged and direct dispatch continues; claim failures become `legacy`; binding and started-mark failures return `false`, which this caller ignores. Thus a delivered prompt can lack durable frozen recovery context or a correctly advanced submission record. The HostState ledger still exists, but the stronger frozen-input recovery guarantees do not uniformly apply. [Acceptance fallback](/Users/bytedance/Project/cognia-next/lib/sync/host-state-service.ts:196), [adapter error handling](/Users/bytedance/Project/cognia-next/lib/work-submission/host-adapter.ts:103), [claim fallback](/Users/bytedance/Project/cognia-next/lib/work-submission/host-adapter.ts:152).

### 4. Restart and replay

Startup calls `recover()`, then settles orphaned queued/running/awaiting-decision/stopping turns as runtime unavailable, then starts heartbeat and reports ready. Any failure reports degraded while retaining the writer role. Pending/failed dispatch, pending broadcast and pending summary work are selected across stored rows and sorted by `hostSeq`. The recovery loop stops on the first thrown row; there is no per-row catch, bounded retry/backoff, dead-letter threshold, or periodic HostState recovery sweep in this service. [Startup](/Users/bytedance/Project/cognia-next/lib/sync/host-state-service.ts:970), [pending selection](/Users/bytedance/Project/cognia-next/lib/sync/host-state-store.ts:615), [recovery loop](/Users/bytedance/Project/cognia-next/lib/sync/host-state-service.ts:1142), [orphan settlement](/Users/bytedance/Project/cognia-next/lib/sync/host-state-service.ts:1389).

A separate WorkSubmission outbox does run periodically on renderer and headless hosts. It isolates failures per row, checks recorded tool effects before replay, handles expired dispatched claims with takeover abort, and reuses frozen context. That is meaningful coverage for chat enqueues, but it does not make HostState's own recovery path identical, nor retry steer/abort/decision actions. [Outbox safety](/Users/bytedance/Project/cognia-next/lib/work-submission/outbox-runner.ts:90), [periodic loop](/Users/bytedance/Project/cognia-next/lib/work-submission/outbox-runner.ts:252), [renderer wiring](/Users/bytedance/Project/cognia-next/components/providers/initializers/deferred-boot-initializers-impl.tsx:61), [headless wiring](/Users/bytedance/Project/cognia-next/lib/headless/runtimes/initializers.ts:412).

## Confirmed gaps and crash-boundary risks

| Priority | Finding                                                                        | Evidence and consequence                                                                                                                                                                                                                           | Focused repro/check                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Duplicate receipt identity is ignored during dispatch                          | Acceptance can return `work:hoststate:action-1` for the same message under `action-2`; claim/bind/mark still derive IDs from `action-2`. No row means `legacy`, so a new command ID may be sent. Heartbeat alone uses the returned receipt ID.     | Combine the real adapter and dispatcher: accept/send action 1, submit the same message ID with action 2, assert one runtime send and one run. Current tests assert one submission row only. |
| P1       | HostState redrive bypasses observed-effect recovery policy                     | `claimWorkSubmission` marks expired dispatched takeover with `takeoverRequired`; the Host adapter discards this detail and returns `claimed`. HostState does not call `planWorkSubmissionRecovery` or abort the prior runtime before sending.      | Persist a failed/pending HostState action plus an expired dispatched WorkSubmission and `tool.started` journal event; restart Host and assert recovery-required with no new send.           |
| P1       | Transient dispatch failure may become durable work without a reachable retry   | Submit commits then throws; no periodic HostState redrive exists. Production RPC caches failure receipts, so same-key network retries replay them rather than entering the service during retention. Internal startup recovery is a separate path. | Inject one transient runtime error through real RPC routing; retry the same key; restore runtime without restarting Host and verify who actually redrives the action.                       |
| P2       | Writer heartbeat begins after potentially long recovery                        | A recovery dispatch lasting beyond 30 seconds can outlive the writer lease before its heartbeat starts. Subsequent projection can fail lease validation; another owner may acquire authority.                                                      | Hold dispatch beyond TTL under fake clock, allow another owner to acquire, release dispatch, and assert no stale owner effects.                                                             |
| P2       | Orphan settlement can classify newly redriven work as lost                     | The scan runs after redrive and examines current turn status without excluding channels/turns just restarted. A successful replay that remains queued or emits `started` during recovery can be marked unavailable/expired.                        | During recovery make dispatch emit runtime `started` before returning; assert the restarted turn remains running after `start()`.                                                           |
| P2       | Ledger payloads/receipts have no implemented compaction in inspected ownership | The action-row comment says payload is compactable once settled; current writes never remove `action`, and no HostState prune/compactor call was found under `lib/`. Recovery selection scans this growing table.                                  | Retention test: settle many actions, invoke central retention, inspect retained payload/row counts and recovery scan cost.                                                                  |

The first two paths follow directly from the current call chain. Their end-to-end effect still depends on lower runtime deduplication and concurrent outbox timing. The startup orphan/lease cases are race risks needing explicit fault-injection tests, not observed runtime failures.

Identity evidence: [existing duplicate-message adapter test](/Users/bytedance/Project/cognia-next/lib/work-submission/host-adapter.test.ts:110), [original receipt returned](/Users/bytedance/Project/cognia-next/lib/work-submission/service.ts:185), [action-derived claim](/Users/bytedance/Project/cognia-next/lib/work-submission/host-adapter.ts:158), [takeover flag](/Users/bytedance/Project/cognia-next/lib/db/work-submissions.ts:281), [outbox replay safety](/Users/bytedance/Project/cognia-next/lib/work-submission/outbox-runner.ts:90), [tool-effect recovery planner](/Users/bytedance/Project/cognia-next/lib/work-submission/recovery.ts:75).

## Retention and rejection semantics

WorkSubmission encrypted input/context have a 30-day TTL; central payload pruning leaves the receipt record. This is different from HostState action retention, and also different from an RPC idempotency receipt's retention. No single global “queue TTL” describes all three. [WorkSubmission TTL](/Users/bytedance/Project/cognia-next/lib/db/work-submissions.ts:43), [payload pruning](/Users/bytedance/Project/cognia-next/lib/db/work-submissions.ts:428).

`host-state-intent-settlement.ts` is organizational-intent compatibility handling, not a chat-send retry engine. An older Host's unsupported-submit error applies supported list changes locally; an understood refusal does not override Host authority. Failed settlement is logged after the receipt is recorded, and does not reopen a retry. Message enqueue/steer have no local apply fallback in this switch. [Settlement](/Users/bytedance/Project/cognia-next/lib/sync/host-state-intent-settlement.ts:29).

## Verification performed

Existing tests run on 2026-10-19, with no coverage collection:

```text
rtk pnpm exec jest --runInBand --runTestsByPath \
  lib/sync/host-state-store.test.ts \
  lib/sync/host-state-service.test.ts \
  lib/sync/host-state-intent-settlement.test.ts \
  lib/work-submission/host-adapter.test.ts

Test Suites: 4 passed, 4 total
Tests:       118 passed, 118 total
Time:        23.527 s
```

An additional targeted run covered the default HostState dispatcher and WorkSubmission replay policy:

```text
rtk pnpm exec jest --runInBand --runTestsByPath \
  lib/sync/host-state-dispatcher.test.ts \
  lib/work-submission/recovery.test.ts \
  lib/work-submission/outbox-runner.test.ts

Test Suites: 3 passed, 3 total
Tests:       49 passed, 49 total
Time:        5.23 s
```

Combined: seven suites and 167 tests passed. `git diff --check` for this report returned no errors.

These tests cover atomic duplicate acceptance, revision/lease refusal, restart redrive, orphan settlement, degraded recovery, dispatch failure followed by explicit recovery, runtime command correlation, attachment refusal, and fail-open dispatch. The service suite mocks the WorkSubmission adapter, while the adapter suite does not dispatch the returned duplicate receipt; the two P1 integration gaps above are not disproved by those passing tests. [Service mocks](/Users/bytedance/Project/cognia-next/lib/sync/host-state-service.test.ts:47), [duplicate test](/Users/bytedance/Project/cognia-next/lib/work-submission/host-adapter.test.ts:110).

No real device disconnect, process kill, long dispatch, or duplicate tool side effect was exercised. The proposed fault-injection cases remain follow-up verification work.

## Physical persistence: what survives a Host process restart

The headless brain uses in-memory IndexedDB for Dexie, but this is not its complete persistence mechanism. `serve-command` starts durability before bootstrapping runtimes. Backend resolution honors an existing account manifest/data; a fresh long-lived brain defaults to `sqlite-v5`. An explicit `snapshot-v3` configuration remains available. Thus “uses fake-indexeddb” does not imply “all Host messages disappear on exit.” [Boot ordering](../../cli/src/serve/serve-command.ts:125), [backend selection](../../cli/src/serve/durability.ts:43).

| Host storage mode | Implemented guarantee                                                                        | Limit                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `sqlite-v5`       | Generic Dexie row store, WAL, `synchronous=FULL`, atomic SQL commit, integrity check on open | Requires the actual Host data directory to survive deployment/recreation; no replicated-storage guarantee follows from WAL. |
| `journal-v4`      | Synchronous journal append plus `fsync`; checked sequence/checksum; checkpoint replay        | Recovery correctness still depends on the action/runtime state machine.                                                     |
| `snapshot-v3`     | Mutation-triggered debounced persistence and exit flush                                      | Abrupt termination can lose the debounce window; must not promise the ledger backend's acknowledgment guarantee.            |
| Desktop Tauri     | Dexie in the WebView's persistent IndexedDB                                                  | Browser-origin/profile/storage deletion and quota/disk failure remain distinct from a runtime failure.                      |

The durability capture records committed transactions synchronously before Dexie's transaction-completion promise resolves. The primary account DB is persisted generically; exclusions inspected here are derived `sessionList` and `scheduledTaskRuns`, not HostState, WorkSubmission, outbox or attachment staging. A backend manifest is written with staging/fsync/rename. Existing manifests take precedence over the default, so a real deployment's active mode must be inspected before asserting its crash guarantees.

Sources: [transaction capture](../../cli/src/serve/persistence/capture.ts:1), [store capture installation](../../cli/src/serve/persistence/store.ts:240), [SQLite](../../cli/src/serve/persistence/sqlite.ts:1), [journal commit](../../cli/src/serve/persistence/journal.ts:257), [manifest](../../cli/src/serve/persistence/manifest.ts:96), [table exclusions](../../cli/src/serve/durability.ts:127), [snapshot fallback](../../cli/src/serve/durability.ts:245).

For a cloud/container Host, retaining only the working repository is insufficient. The account durability root, security/receipt store, attachment/media storage, and required encrypted-ledger keys must survive together. The source establishes local persistence; this audit did not inspect a deployed volume, backup, restore, filesystem-loss tolerance, or active backend manifest. Process restart, container recreation, and Host disk loss are different failure classes.

## Client outbox and its recovery behavior

The client writes an action into `mobileOutboundQueue` before displaying HostState optimism. Although historically named mobile, the runner is shared by attached Web, Mobile and Desktop. A transaction allocates stable `actionId`, `clientId`, `clientSeq`, host generation, and UUID idempotency identity. Capacity is bounded at 1,000 in-flight HostState rows. Account/target scope is fixed at enqueue and checked across async work. [Durable enqueue](../../lib/db/mobile-outbound-queue.ts:131), [shared lifecycle](../../components/providers/companion-outbound-runner-provider.tsx:125).

The runner transactionally claims the oldest eligible channel head. Only the lowest outstanding sequence in each channel can dispatch; a delayed pending send therefore also delays a later Stop/Steer on that channel. Claims renew every 30 seconds and are reclaimable after two minutes without renewal. Preflight rejection/timeout releases the claim without consuming retry attempts. Host consent and manifest updates thaw held work; account/target transitions quiesce the previous runner. [Channel ordering](../../lib/db/mobile-outbound-queue.ts:620), [claim constants](../../lib/db/mobile-outbound-queue.ts:811), [runner](../../lib/queue/outbound-queue.ts:277), [preflight/lifecycle](../../components/providers/companion-outbound-runner-provider.tsx:247).

Transient dispatch failures use exponential backoff with jitter, default budget five failed attempts, then durable `deadlettered`. The policy classifies failures mainly from message regexes; it does not consume `CompanionError.retryable` as a structured decision. The inner HTTP transport does honor structured retryability and Retry-After, so inner transport and outer outbox retry policy are not identical. A terminal permissions/unsupported error not matching the outer patterns can still spend the outer retry budget. [Retry policy](../../lib/queue/retry-policy.ts:16), [failure write](../../lib/db/mobile-outbound-queue.ts:1017), [HTTP handling](../../lib/tauri/transport-companion.ts:2057).

HostState receipts map `applied`/`duplicate` to outbox `sent`, and `rejected`/`conflicted` to their explicit terminal statuses. Here `sent` means the submit receipt settled, not model consumption or successful completion of its tools. The UI queue lists pending/sending/deadlettered/rejected/conflicted; deadletters offer Retry/Discard, rejected/conflicted offer Discard. Conversation-channel pending sends cannot be withdrawn through this sheet. Standalone withdrawal can return `withdrawn-unconfirmed`, explicitly acknowledging that an earlier attempt may have reached the Host. [Receipt mapping](../../lib/db/mobile-outbound-queue.ts:925), [queue UI](../../components/mobile/outbound-queue-sheet.tsx:1), [withdrawal](../../lib/db/mobile-outbound-queue.ts:1080).

### Host generation changes and manual retry

Before bytes leave the client, `offerHostStateRow` persists `offeredHostGeneration`. An action never offered can be safely re-stamped forward onto the same Host's confirmed generation. An already-offered action retains its generation because its outcome may be unknown. A first-offer stale-generation rejection can forget the offer, resync, and retry; an uncertain prior offer is rejected rather than blindly reinterpreted under the new generation. This is useful existing protection.

Manual `retryDeadletter` retains action/idempotency identity, resets attempts, moves the local row sequence behind outstanding work, and clears `offeredHostGeneration`. That expresses a deliberate user resend; it is not proof the earlier attempt did nothing. Moreover, the sequence update is on the row; the stored action payload is not rebuilt there. Any later generation re-stamp mutates the request body while reusing its wire UUID. The production RPC digest rejects a changed body under the same UUID. These layers require an integrated retry contract: an unchanged request retries one submission; a new attempt must have its own transport identity while retaining a stable domain work identity and checking the old outcome.

Sources: [offer fence](../../lib/db/mobile-outbound-queue.ts:723), [stale first-offer handling](../../lib/queue/outbound-queue.ts:430), [manual retry](../../lib/db/mobile-outbound-queue.ts:1160), [request hashing](../../crates/cognia-companion/src/remote_execution.rs:460).

## Production RPC receipts and runtime deduplication

The production canonical RPC path uses `SecurityStore` idempotency records. `host_state_submit` requires a UUID and uses the ordinary replay receipt policy; the Host-semantic exception is for a separate managed-desktop-result resource. The request digest includes command and arguments. Same key/different body conflicts. Same key/in-progress returns an accepted operation. Successes **and failures** receive durable terminal receipts and are replayed on a subsequent identical request. [Canonical execution](../../crates/cognia-companion/src/remote_execution.rs:425), [receipt policy](../../crates/cognia-companion-contract/src/command_manifest.rs:141), [HostState descriptor](../../protocol/companion-commands.json:12501).

Consequences:

- HostState can durably accept a semantic action, fail to dispatch it, and throw; the RPC then stores that failure. Repeating the wire UUID replays the failure, not a fresh dispatch. Client backoff alone cannot repair this window. The WorkSubmission worker may rescue eligible messages, while HostState control intents have different recovery paths.
- An uncertain in-progress call can return an operation document, while the HostState outbox expects a submit result. The transport returns HTTP 202 documents whole; the outbox has no operation-polling branch and treats a non-submit response as `host_state_malformed_response`. Its same-key retry may eventually find a completed receipt, but this is not explicit reconciliation of the operation ID.
- On SecurityStore reopen, unfinished operations are recorded as `operation_interrupted` with a terminal error receipt; that reports an unknown/interrupted result, not proof that no external side effect occurred. Replaying the same key reproduces this receipt during retention.
- Terminal receipts are pruned after 24 hours; receipt-null entries are excluded from the retention sweep. The server runs the sweep periodically. Expiration reopens the ability to execute at the RPC layer; correctness then depends on the domain's own work dedupe. An old manual retry must not claim an unconditional exactly-once guarantee.

Sources: [failure receipt](../../crates/cognia-companion/src/remote_execution.rs:540), [operation acceptance](../../crates/cognia-companion/src/remote_execution.rs:483), [202 handling](../../lib/tauri/transport-companion.ts:2042), [expected submit response](../../lib/queue/outbound-queue.ts:398), [restart settlement](../../crates/cognia-companion-security/src/security_store.rs:2570), [retention](../../crates/cognia-companion-security/src/security_store.rs:1543), [maintenance](../../crates/cognia-companion/src/server.rs:334).

Do not confuse the older `IdempotencyCache` implementation with this production canonical path: the old RPC handler containing its `begin/complete` calls is test-only. Its expiry behavior is not the production SecurityStore retention contract.

The sidecar `commandId` dedupe is a module-level Map remembering up to 256 sessions and 128 command IDs per session. It survives retiring a live session object, but not sidecar process restart or cache eviction. It also records a seen command before processing rather than storing a durable successful-effect receipt. The Host's durable work identity must carry recovery correctness across that boundary. [Runtime cache](../../sidecar/src/host/commands/ledger.ts:1).

## Attachments, drafts, and delayed sends

Remote sends upload attachment bytes before enqueueing refs. Upload init resumes the same session/device/content hash; chunks follow the Host's offset, and commit checks length/hash/content. Upload state is persisted. Partial uploads expire after 30 minutes of inactivity; committed unconsumed objects after 24 hours. The collector does not inspect pending client outboxes; a queued ref therefore is not an indefinite pin. Consumption happens after the runtime handoff and releases staging bytes; later reuse must rebuild from persisted message/media assets. [Upload client](../../lib/companion/attachment-upload-client.ts:108), [staging TTLs](../../lib/db/session-attachment-uploads.ts:98), [collector](../../lib/db/session-attachment-uploads.ts:578), [dispatch resolution](../../lib/sync/host-state-service.ts:111).

The remote composer keeps text/files on an immediate upload/send rejection. However, successful `onSend` can mean **local durable enqueue**, because the hook returns immediately when it obtains an outbox row. The composer then clears its draft and original staged bytes; its comment saying the Host already has the message is stronger than that actual handshake. A later Host refusal or attachment expiry needs a restore/reupload path using the outbox/message assets; retaining a visible failed row alone does not restore the original local file.

Sources: [queued early return](../../hooks/data/use-remote-session-stream.ts:474), [draft clear](../../components/mobile/remote-sessions/remote-session-composer.tsx:340), [missing attachment refusal](../../lib/sync/host-state-service.ts:134).

## Failure handling matrix

| Failure point                                                           | Current behavior / evidence                                                        | Required recovery contract or remaining gap                                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Client local DB quota/disk/write failure                                | Enqueue throws before the hook returns; immediate send rejection keeps draft/files | Never show durable acceptance; offer retry/export without clearing input. A real quota failure was not injected.                    |
| Host offline / required consent unavailable                             | Durable client outbox; preflight holds without consuming attempts when blocked     | Show waiting reason and owner, not running/consumed. Preserve target identity.                                                      |
| Network failure before Host sees request                                | Same UUID/body retries with bounded backoff; deadletter after budget               | Retry same submission; retain reconstructable payload and expose retry/discard.                                                     |
| Host executes but reply is lost                                         | RPC receipt and Host action identity can reconcile/replay                          | Query operation/action before minting new work; timeout is uncertain, not undelivered.                                              |
| Client killed during Sending                                            | Renewable claim becomes reclaimable after two minutes                              | Resume same work and identity; expose stuck/uncertain during recovery.                                                              |
| Host commits action then runtime dispatch fails                         | Durable failed Host action; RPC can cache failure                                  | Independent Host dispatch recovery must converge; client retries cannot merely replay a terminal transport error forever.           |
| Host dies before runtime handoff                                        | Startup HostState recovery plus WorkSubmission worker                              | One owner/lease and one replay policy; bounded progress despite a poisoned row.                                                     |
| Host dies after tool side effect, before terminal record                | HostState redrive can bypass effect planner; sidecar cache is not durable          | Reconcile tool/run evidence; recovery-required when uncertain; never automatically repeat a non-idempotent effect.                  |
| Same message is resent with another action ID                           | Work acceptance dedupes by message; later dispatch derives fresh action IDs        | Propagate the existing receipt/submission/run identity through every subsequent operation.                                          |
| Host restarts with a new generation                                     | Safe first-offer rebase; uncertain old offer preserved/rejected                    | Resolve old action/operation outcome before manual resend; align request digest and domain identity.                                |
| Delayed Steer/Stop arrives after the original turn ended                | Intent names the session; no `expectedTurnId` or expiry in its closed shape        | Fence live controls to the intended run/turn and deadline; never steer/abort a later unrelated turn.                                |
| Stop sits behind a backoff send                                         | Per-channel FIFO blocks later channel entries                                      | Define a live-control lane or guarded priority path; queue management must not make Stop appear effective before Host ACK.          |
| Attachment transfer fails                                               | Composer keeps draft/files; hash-based upload resumes                              | Retry upload; preserve progress and originals until a reconstructable durable input owns them.                                      |
| Attachment ref expires while waiting                                    | Ref resolution refuses whole send rather than dropping files silently              | Show files needing reupload, restore originals when available, and pin refs held by accepted durable work.                          |
| Device revoked / control denied / protocol unsupported                  | Structured refusal or terminal outbox state; control can downgrade                 | Explain remedial action; do not endlessly retry unchanged authorization/schema failures.                                            |
| Provider rate limit, temporary server error, context/auth/model refusal | Beyond delivery: model run can fail after submit is `sent`                         | Separate execution retry from delivery retry; use run/error class and observed effects. Outbox `sent` is not successful completion. |
| User discards/withdraws after an uncertain send                         | Standalone withdrawal reports unconfirmed; channel pending withdrawal unavailable  | “Discard local retry” must not claim “canceled Host execution”; cancellation needs a Host-side receipt.                             |
| Queue edited/reordered from two devices                                 | Local renderer queue ops are not Host mutation commands                            | Host revision/CAS, stable entry IDs, dispatch-state guard, conflict UI, and acknowledged order.                                     |
| Target switch / unpair / Host replacement                               | Scoped rows, runner quiesce, same-Host generation checks                           | Never send old work to the newly selected Host implicitly; define migration/cancel/export.                                          |
| Container recreated / disk lost                                         | Local ledger survives only if its files/keys survive                               | Persist volumes and test backup restore; storage replication is not established by current source tests.                            |

Live-control evidence: [intent shapes](../../packages/agent-config-types/src/host-state.ts:243), [revision-required subset](../../lib/db/mobile-outbound-queue.ts:561), [session-scoped dispatch](../../lib/sync/host-state-service.ts:309), [optimistic Stop return](../../hooks/data/use-remote-session-stream.ts:530).

## Design requirements for a complete follow-up

These are proposed requirements, not implemented fixes:

1. **One work identity, several attempt identities.** A user message owns a stable work/message ID. Every transport submission attempt has an immutable UUID/body. Execution attempts and Host generations are separate fields; an existing accepted receipt supplies the authoritative submission/run IDs.
2. **Persist the executable input.** Text, attachment content references, citations, reply target, frozen execution context, intended delivery mode/order, and recovery policy must be durable before the UI releases its only recoverable copy. Pin assets for as long as unresolved work refers to them.
3. **Separate delivery from execution states.** Use local-saved → pending-Host → Host-committed → runtime-accepted → consumed if observable → completed. Also expose waiting, rejected, failed, canceled and outcome-unknown. A transport ACK must not masquerade as model consumption or tool success.
4. **Reconcile before retry.** Lost ACK/crash/receipt expiry queries the existing work/run/effect record. Safe resend, uncertain recovery, and user-requested rerun are different actions. Recovery cannot rely on an in-memory command cache.
5. **Fence live controls.** Steer, abort and approval answers carry the intended run/turn/request and expiration. A next-turn queued message can survive offline; a stale instruction to the current turn requires a different policy.
6. **Recover continuously and fairly.** Start/renew leases before long recovery, isolate poison rows, use bounded retries with structured classes, and expose terminal failures. A single failed action cannot prevent unrelated recovery or reader readiness.
7. **Make remote queue edits authoritative.** Host-owned CAS updates/moves/cancels, stable IDs and acknowledged order; changes after admission need an explicit runtime capability or a new correction message.
8. **Provide contextual recovery controls.** A failed message needs View reason, Retry delivery, Restore/edit, Reupload missing files, and Discard retry as appropriate. Already-started work needs Resume/Recover or Rerun with effect disclosure. Desktop and mobile should show the same owning Host/run and outcome.

Acceptance scenarios should inject failures immediately before/after each durable commit, runtime acceptance, tool start, tool result, completion receipt, and client ACK. Test first-offer versus previously-offered generation changes, multiple windows/devices, new action IDs for the same message, expired receipts/assets, permission revocation, and disk/quota failure. Killing the full Host is distinct from killing only its sidecar or client.

## Additional verification

Client outbox/transport/attachments/UI: **9 suites, 441 tests passed**:

```sh
rtk pnpm exec jest --runInBand --runTestsByPath lib/db/mobile-outbound-queue.test.ts lib/queue/outbound-queue.test.ts lib/queue/retry-policy.test.ts lib/tauri/transport-companion.test.ts lib/companion/attachment-upload-client.test.ts lib/db/session-attachment-uploads.test.ts components/mobile/outbound-queue-sheet.test.tsx components/providers/companion-outbound-runner-provider.test.tsx hooks/data/use-remote-session-stream.test.ts
```

Physical headless durability: **5 suites, 111 tests passed**:

```sh
rtk pnpm exec jest --runInBand --runTestsByPath cli/src/serve/durability.ledger.test.ts cli/src/serve/persistence/store.test.ts cli/src/serve/persistence/capture.test.ts cli/src/serve/persistence/journal.test.ts cli/src/serve/persistence/sqlite.test.ts
```

Together with Host recovery checks above: **21 suites, 719 tests passed** in this extension. The previous steer/queue audit separately ran 18 suites/502 tests. No coverage collection, Rust test/build, live Host deployment, real provider run, destructive kill, or end-to-end network fault injection was performed. Expected mocked transport/failure logs appeared in passing tests. Piecewise passing tests do not prove the cross-layer crash/retry contracts listed as gaps.
