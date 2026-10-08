# Additional transfer and state-sync performance — 2026-10-08

Continuation of the [2026-10-07 experiments](../multi-device-performance-2026-10-07/README.md). Work began on a shared dirty tree at `5f6760382213f58cf9614caa1c7d0f3ea90a9709`. Prior optimizations and unrelated changes were preserved. Each experiment freezes its baseline before production edits, pre-registers its workload, and accepts a change only with at least 10% median improvement beyond twice the larger median absolute deviation (MAD), with correctness and regression guards passing.

## Collaboration issue mirror

The existing replacement logic loaded, decrypted and sorted old issue bodies solely to identify stale IDs. The existing `orgId` and `[orgId+workspaceId]` indexes now provide those IDs directly. Replacement retains its transaction, stale deletion, complete incoming writes and exact scope semantics. Scoped clearing uses the same key-only selection. No schema, wire format, encryption policy or board-rendering query changed.

Native Chromium, complete CogniaDB schema and active at-rest encryption; one warmup then ten alternating samples per variant:

| Exercised path                          | Baseline median / MAD | Result median / MAD | Decision          |
| --------------------------------------- | --------------------: | ------------------: | ----------------- |
| Refresh 1,024 issues, 4 KiB body each   |      178.30 / 3.15 ms |    138.40 / 3.50 ms | **22.38% faster** |
| Refresh 256 issues in one workspace     |       40.00 / 0.50 ms |     30.35 / 0.35 ms | **24.13% faster** |
| Clear 1,024 issues for one organization |      104.60 / 5.65 ms |     62.95 / 1.40 ms | **39.82% faster** |

The 1,024-row refresh still receives 4,518,544 fixture response bytes and writes all 1,024 complete rows. Old-body value reads decrease from 1,024 to zero; 1,024 index keys are still read. The clear workload still deletes exactly 1,024 rows. Empty-result deletion and a single-row refresh pass their guards. Every sample checks exact durable contents, body, revision, board order, ciphertext, and same-named workspaces belonging to another organization. Separate native failure and key-lock guards verify rollback and fail-closed behavior.

This measures actual `pullCollabIssues`/`clearCollabIssues` through local persistence with deterministic in-process server responses. It excludes network latency, remote authorization and UI rendering. Indexed key order replaces the previous incidental board-order sort during stale deletion; no identical ordered deletion-hook callback claim is made. No first-party hook on this mirror table was found.

[Detailed report, raw samples, contracts and reproduction](collab-issue-keys/report.md).

## Memory synchronization cache pruning

After each nonempty apply slice, pruning previously loaded and decrypted every cached memory before checking the cache limit. It now counts first and returns when within the limit. Overflow retains the existing full read, length recheck, pinned/recency/update/ID ordering and deletion behavior.

The native-browser experiment exercises actual `syncMemories`, wire decoding/decryption and encrypted CogniaDB writes, with one warmup and ten alternating samples per variant and workload:

| Exercised path                                    | Baseline median / MAD | Result median / MAD | Decision                       |
| ------------------------------------------------- | --------------------: | ------------------: | ------------------------------ |
| Apply 200 memories to 800 cached, 4 KiB text each |       88.30 / 1.15 ms |     55.00 / 1.10 ms | **37.71% faster**              |
| Apply 200 to 1,000 cached, prune back to 1,000    |      118.30 / 3.30 ms |    117.55 / 1.25 ms | Within noise; no speedup claim |

The primary workload still receives 1,197,449 wire bytes, decrypts and writes all 200 incoming rows, and preserves the cursor and exact durable content. Cached payload reads decrease from 1,000 to zero, with one count added. Single-row and empty-delta guards show no qualifying regression. Separate guards cover missing DEK, tampered AAD, cancellation, replay and the production account-lock API. Account-sync capture is disabled in this experiment; real pairing and network costs are excluded.

The original snapshot concurrency boundary remains: pruning does not guarantee an atomic hard capacity limit during concurrent writes. Directly calling a cipher instance's `lock()` while leaving it globally registered produces an artificial intermediate state with different behavior; this is recorded as a failed exploratory guard, not counted as a pass. Production `lockAccountContentCipher()` synchronously clears that registration and rejects both variants. No claim covers every possible concurrent lock timing.

[Detailed report, raw samples, contract and reproduction](memory-prune/report.md).

## Follow-up: live HostState snapshot and event application

The client previously scanned every outbound job whenever it rebuilt optimistic state after a snapshot or live event. It now uses the existing status index for `pending` and `sending`, preserving protocol/channel filtering and action validation. Sorting by ID before the existing stable client-sequence sort preserves the old order when sequence numbers tie across statuses.

Native Chromium, actual `installHostStateSync`, full CogniaDB and actual chat store; one warmup and ten alternating measured samples per variant/workload:

| Exercised path                                                       | Baseline median / MAD | Result median / MAD | Decision                   |
| -------------------------------------------------------------------- | --------------------: | ------------------: | -------------------------- |
| Snapshot application with 2,048 settled jobs and 8 active/mixed jobs |       37.05 / 0.50 ms |     16.15 / 0.30 ms | **56.41% less time**       |
| Subsequent live-event application with the same backlog              |       35.65 / 0.40 ms |     14.90 / 0.20 ms | **58.20% less time**       |
| Snapshot with only the 8 active/mixed jobs                           |        2.10 / 0.05 ms |      2.10 / 0.10 ms | Unchanged                  |
| Live event with only the 8 active/mixed jobs                         |        1.80 / 0.10 ms |      1.90 / 0.10 ms | Within preregistered guard |

Every sample preserves exact visible and durable projections, template parameters, the complete outbound queue, two RPC calls and 919 fixture wire bytes. Current table policy classifies `mobileOutboundQueue` as metadata-only: the gain avoids scanning and deserializing settled jobs, not decrypting them. The existing later rejected/conflicted-message cleanup remains unchanged. No schema or table-policy changes were made.

Canonical account-lock and stop-during-resync guards retain baseline behavior. Lock rejection can follow a metadata-only confirmed-channel write; this preexisting partial persistence is documented, and no new atomicity claim is made. Small-queue outliers remain in the raw data; no tail-latency claim is supported.

[Detailed report and reproducible evidence](host-state-pending/report.md).

Another investigated shortcut, replacing old-record reads with existence checks during account-sync deletion, was rejected before implementation because it would skip authentication of the old encrypted body. [Rejected-candidate record](account-delete-existence/report.md).

A separate account-sync key-reuse experiment reduced HKDF derivations from 256 to 1 but did **not** improve the complete apply path beyond noise: 87.30 ms (MAD 2.65) versus 86.85 ms (MAD 4.20), a 0.52% difference. Its production and test hunks were removed; no crypto-cache optimization is retained. [Rejected experiment and raw evidence](account-apply-key/report.md).

## Other paths assessed

- Session replication's old-row lookup was investigated, but another concurrent change began optimizing the same files. Those edits were preserved and are not attributed to this round.
- Explicit transcript-turn paging still materializes an entire turn before its page limit. An alternative using existing key indexes would scan all session keys and needs consistency, legacy-row and short-turn/large-session guards. No unmeasured paging change was made.
- Workspace-roster fan-out and activity fetching were inspected. Membership-authority ordering, partial failures and network conditions make naive concurrency increases inappropriate without a separate contract; those paths were preserved.

## Validation boundary

The evidence is for the exercised native-browser local paths. It does not establish real two-device, WAN/relay, packet-loss, Tauri/Capacitor, battery, UI or production-server performance. Payload parity means no bandwidth-reduction claim. All fixtures are synthetic, use isolated databases and local browser origins, and preserve current lock and authority checks.

The earlier mirror/memory pass has **109 tests in 9 suites** passing; see its [verification details](verification.md). The subsequent HostState pass has **181 tests in 9 suites** passing after repairing a stale dispatcher fixture, with scoped ESLint, Prettier and diff checks passing; see [follow-up verification](round4-verification.md). These runs overlap and must not be added together. Global typecheck and lint remain blocked by errors outside the retained changes. Changes remain uncommitted.
