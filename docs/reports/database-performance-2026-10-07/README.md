# Database and state synchronization performance — 2026-10-07

## Scope and method

This investigation covers the current shared working tree, including pre-existing
uncommitted changes. `environment.json` records the initial revision and status.
It does not measure the user's live data. All benchmarks use disposable synthetic
databases and local keys, with warmup, repeated samples, and saved raw results.
Baseline and candidate run on the same machine and toolchain. Retained results
use coordinated timing windows; the initial overlapping plaintext sync run is
explicitly excluded from performance claims.

Each experiment records its contract before production edits. A performance-only
change is retained only when its primary median improves at least 10% and the
absolute improvement exceeds twice the larger median absolute deviation (MAD).
This is an experiment decision rule, not a confidence interval or a CI threshold.
Correctness, account boundaries, cursor advancement, encryption and durability
remain mandatory. No schema/index migration or cache deletion is planned.

## Persistence and synchronization inventory

| User data/path                              | Current owner and implementation                                                                                           | Performance observations and constraints                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation history and streaming messages | `lib/db/schema.ts`, `lib/db/messages.ts`, `lib/db/sessions.ts`                                                             | Canonical renderer data is Dexie/IndexedDB. Recent messages use compound indexes. Streaming persistence already updates the last message and preserves media-reference ownership, session write guards and recovery from out-of-band deletion. Workspace lists also include legacy/paired sessions without a workspace; this change replaces their full encrypted cursor scan with key discovery and selective bulk reads. |
| Encryption and change capture               | `lib/db/encrypted-content-middleware.ts`, `lib/db/message-sync-revision.ts`, `lib/account-sync/data/capture-middleware.ts` | Encrypted reads perform WebCrypto work while retaining IndexedDB transactions. Multiple concurrent transaction holds are unsafe in some paths. Message revisions and account field clocks/outbox entries are captured in the write transaction. Skipping encryption or capture would invalidate a speed comparison.                                                                                                        |
| Paired host → companion data                | `lib/sync/desktop-sync-source.ts`, `lib/sync/companion-sync.ts`, `lib/sync/handlers/base.ts`                               | Messages drain a revision index; workflow runs use an activity/id index. Initial history is bounded. Deletions have an independent cursor. Sync scheduling already coalesces invalidations and controls concurrency; increasing concurrency is not assumed to improve throughput.                                                                                                                                          |
| Unread state and offline actions            | `lib/sync/handlers/session-state.ts`, `lib/sync/host-state-service.ts`, `lib/sync/host-state-store.ts`                     | Pending local read/unread choices must survive older host snapshots. Their account and target scope, watermark maxima and client-sequence tie breaks are part of correctness. This change aggregates read watermarks during the existing pending-queue pass instead of reducing the queue again for every incoming row.                                                                                                    |
| Account replication                         | `lib/account-sync/data/engine.ts`, `sync-round.ts`, `pusher.ts`, `applier.ts`                                              | Separate push/pull lanes, encrypted signed operations, per-field HLC merges, tombstones, future-key/schema inbox and durable cursors. Pusher changes already existed before this task and are not attributed to it. The applier derives an op subkey for each operation; an isolated experiment tests whether call-local reuse matters end to end.                                                                         |
| Native SDK transcript mirror                | `crates/cognia-agent-state/src/agent_session_store/`                                                                       | Separate from canonical renderer conversations. SQLite transaction durability and mirror recovery remain intact. See the native investigation for the measured append dispatch path.                                                                                                                                                                                                                                       |
| Headless degraded store                     | `crates/cognia-companion-bus/src/store.rs`, `data_plane.rs`                                                                | SQLite fallback when the renderer data plane is unavailable. It must not be presented as the primary renderer database. No fallback optimization is assumed to improve normal chat.                                                                                                                                                                                                                                        |
| Organization collaboration                  | `lib/collab/sync.ts`, `shared-chat-sync.ts`, `notifications-sync.ts`                                                       | Server-authoritative local mirrors; failed pulls retain previous data. Notification cursors/read queues are scoped by account, endpoint and organization. Workspace roster pulls are sequential, but no live server workload was measured, so no network speed claim is made.                                                                                                                                              |
| Canvas/artifact local persistence           | `lib/canvas/dexie-bridge.ts`, `lib/artifacts/dexie-bridge.ts`                                                              | Canvas bridge already gates unchanged object identities, debounces document writes, batches transactions and guards account changes/hydration failures. Version reconciliation still visits in-memory versions; no evidence yet justifies altering lifecycle or flush semantics.                                                                                                                                           |
| Collaborative editor content                | `lib/canvas/collaboration/crdt-store.ts`, `websocket-provider.ts`                                                          | Yjs updates and snapshots, distinct from ordinary row replication; remote-origin suppression prevents echo. Correctness includes reordered updates, document disposal and awareness cleanup. Not benchmarked in this task.                                                                                                                                                                                                 |
| Persisted UI preferences                    | `stores/persist-storage.ts` and per-store `partialize` configurations                                                      | Browser localStorage; synchronous JSON persistence is distinct from database transactions. Node and unavailable storage use an inert implementation. No blanket cache/debounce was introduced because it could alter durability or account-switch behavior.                                                                                                                                                                |

## Experiment results

All numbers below are medians in milliseconds; values in parentheses are MAD.
The host is an Apple M4 Pro with 48 GiB RAM and macOS 26.5.2. Browser measurements
use Chrome 151, native IndexedDB and the actual encryption middleware. Data is
synthetic, bundles are minified, and network/provider time is excluded.

| Measured operation and fixture                                                               |         Baseline |           Result |              Improvement | Verdict                                             |
| -------------------------------------------------------------------------------------------- | ---------------: | ---------------: | -----------------------: | --------------------------------------------------- |
| Count visible workspace conversations/messages; 1,000 sessions, 20,000 messages              |    103.85 (5.60) |     12.70 (0.50) |                   87.77% | Keep                                                |
| List workspace conversations, same fixture                                                   |    102.05 (3.95) |      6.65 (0.15) |                   93.48% | Keep                                                |
| List 1,000 workspace-less conversations                                                      |     94.80 (6.30) |     29.75 (1.00) |                   68.62% | Guardrail passes                                    |
| Count one conversation and its 20 messages                                                   |      0.30 (0.00) |      0.40 (0.05) |           0.10 ms slower | Within predeclared 1 ms guardrail; no speedup claim |
| Apply unread-state sync; 1,000 rows, 5,000 valid pending jobs + 1,000 foreign/unrelated jobs |    259.80 (3.30) |    214.70 (3.20) |                   17.36% | Keep                                                |
| Apply unread-state sync; 200 rows / 200 valid jobs                                           |      8.60 (0.50) |      8.70 (1.20) |             Within noise | Guardrail passes                                    |
| Native SQLite commit; 20,000 new messages × 4 KiB                                            | 568.315 (20.910) | 565.594 (24.578) |                    0.48% | Reject                                              |
| Account-sync encrypted apply; 300 operations                                                 |  248.50 (117.20) |  223.30 (103.90) | 10.14%, below noise rule | Inconclusive; no source change                      |

Conversation measurements use 2 warmups and 12 samples per variant with the
production-default Dexie cache configuration. The count fixture returns exactly
242 visible conversations and 4,840 messages; the listing contains 265 rows before
exposure filtering. Unread sync uses 2 warmups and 15 alternating samples per
variant, applying five 200-row slices for the stress case. Native dispatch uses
release builds and WAL `synchronous=FULL`, 10 samples per variant. No p95 claim is
made from these sample sizes.

The retained source changes are confined to `lib/db/sessions.ts` and
`lib/sync/handlers/session-state.ts`, with their co-located tests and a changeset.
The former avoids decrypting unrelated workspace content and leaves the existing
indexes/schema unchanged; the latter changes repeated O(rows × pending) scans
into O(rows + pending) work per slice. The extra data structures contain IDs and
watermarks. Peak browser heap was not measured, so no memory reduction is claimed.

The conversation transaction-batching attempt was also rejected: its safe variant
improved less than 1%, and combining parallel encrypted scans in one transaction
failed in the real browser. Neither attempt remains in production source.

Detailed contracts, raw samples, reproductions and limitations:

- [Conversation queries](conversations/report.md)
- [Unread-state synchronization](state-sync/README.md)
- [Other state synchronization paths](state-sync/inventory.md)
- [Native experiment](native/README.md) and [native ownership map](native/inventory.md)
- [Account-sync rejected experiment](account-sync/decision.md)

## Correctness and verification

The real encrypted browser checks verified workspace-less/null/empty membership,
stable timestamp ties, title and workspace-change liveQuery updates, and locked
account rejection. Sync measurements asserted exact row contents, cursor/outcome,
tombstone effects and unchanged outgoing queue for every sample. Native samples
asserted complete transcript equality and duplicate replay deduplication.

Focused suites: **12 suites / 519 tests passed**: 196 session/message tests in
`conversations/tests.log` plus 323 encryption, revision, sync handler, host state,
companion orchestration, desktop source and account-sync tests in
`regression-tests.log`. New cases specifically cover pending watermark maxima,
newer lower read snapshots, read/unread ordering, client-sequence ties and session
isolation. Timing thresholds are not installed in CI.

Scoped ESLint and formatting checks passed for all four changed source/test files.
`lint:i18n` and `i18n:sort:check` passed. Read-only correctness and test-gap audits
reported no actionable findings. The change does not add a route, new production
module, outbound model call, TSX string, Rust source change or migration; those
additional preflight auditor triggers do not apply. Coverage was not requested
and was not run.

Full repository gate results are recorded in the accompanying logs; a global
failure outside this change must not be represented as a full passing check.

| Gate                                   | Result                                                   | Evidence                            |
| -------------------------------------- | -------------------------------------------------------- | ----------------------------------- |
| Session/message Jest suites            | 2 suites, 196 tests passed                               | `conversations/tests.log`           |
| Encryption/sync regression Jest suites | 10 suites, 323 tests passed                              | `regression-tests.log`              |
| Changed-file ESLint                    | Exit 0                                                   | `scoped-lint-final.log`             |
| Changed-file Prettier                  | Exit 0                                                   | `scoped-format-final.log`           |
| i18n parity/references and sort        | Exit 0 for both                                          | `lint-i18n.log`, `i18n-sort.log`    |
| Scoped `git diff --check`              | Exit 0                                                   | Recorded in `final-validation.json` |
| Full `rtk proxy pnpm typecheck`        | Exit 2, three diagnostics outside changed files          | `typecheck-retry.log`               |
| Full `rtk proxy pnpm lint`             | Exit 1, 82 errors / 4,852 warnings outside changed files | `lint-recheck.log`                  |

Full type-check diagnostics at execution time:

```text
lib/collab/shared-chat-sync.test.ts(98,40): error TS2339: Property 'syncRevision' does not exist on type 'StoredMessage'.
lib/collab/shared-chat-sync.test.ts(158,20): error TS2339: Property 'syncRevision' does not exist on type 'StoredMessage'.
lib/tauri/transport-companion.test.ts(3006,73): error TS2353: Object literal may only specify known properties, and 'sent' does not exist in type 'Promise<string>'.
```

The initial filtered type-check attempt exited 134 after a 4 GiB Node heap OOM,
despite RTK printing `TypeScript: No errors found`. The raw failure is retained in
`typecheck-initial-raw.log`; it is not treated as a pass. The unfiltered retry ran
the actual repository command with its configured 16 GiB heap and produced the
three diagnostics above. Its later sidecar check did not run because the main
TypeScript step failed.

Full lint reports the generated, unrelated
`src-tauri/resources/plugins/cognia-office/dist/index.js` plus a cached
`components/chat/composer.tsx` render-ref finding. A separate current-source,
no-cache check of `composer.tsx` exits 0 (`composer-lint-no-cache.log`); the global
cached failure is preserved as observed, not silently converted to a pass.
No shared lint cache was deleted and no unrelated source was changed to clear
these gates. Other edits appeared concurrently in this shared tree; the initial
and final status snapshots and final owned-source hashes make the scope explicit.

Re-run the broad regression selection from the repository root:

```sh
rtk pnpm exec jest --runInBand --runTestsByPath lib/db/sessions.test.ts lib/db/messages.test.ts lib/db/encrypted-content-middleware.test.ts lib/db/message-sync-revision.test.ts lib/sync/handlers/base.test.ts lib/sync/handlers/session-state.test.ts lib/sync/host-state-service.test.ts lib/sync/host-state-store.test.ts lib/sync/desktop-sync-source.test.ts lib/sync/companion-sync.test.ts lib/account-sync/data/sync.integration.test.ts lib/account-sync/data/applier.test.ts
```

The implementation and report are uncommitted. No actual user database, account
key, sync endpoint, production service or native installer was changed.

## Interpretation limits

Browser storage API completion and native SQLite dispatch completion are measured
boundaries. They are not app interaction, full IPC round-trip, cloud propagation,
provider response, or device battery measurements. Synthetic fixtures expose
scaling behavior but do not establish the distribution of actual user databases.
Native macOS measurements do not establish iOS WKWebView, Android WebView, Linux,
Windows, cross-window, production network or full packaged-app parity.

## Additional optimization round

[Round 2, completed 2026-10-08](round-2/README.md) measures execution-event batches,
outbound queues and HostState recovery reads. It retains the execution batch change
(540.3 → 253.7 ms for 500 existing events plus 100 appended), rejects three other
candidates, and records the final regression checks and their limits separately.

[Round 3, 2026-10-08](round-3/README.md) retains indexed archived-notification
queries and selective local-context reads during session sync. The delivery-ledger
cleanup candidate is rejected after a measured regression. Its own report records
the final correctness checks and comparison boundaries.

[Round 4, 2026-10-08](round-4/README.md) retains the scoped workflow-failure index
query and removes a duplicate database walk from storage overview loading and
refresh. Chat-result cursor search is rejected because sparse and no-match
queries regress. The round records 351 passing regression tests and gate limits.
