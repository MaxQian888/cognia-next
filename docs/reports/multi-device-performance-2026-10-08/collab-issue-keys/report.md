# Collaboration issue mirror: primary-key queries

Measured 2026-10-08. The public production `pullCollabIssues` path refreshing 1024 encrypted issues with approximately 4 KiB bodies completed **22.38% faster**, and org-scoped `clearCollabIssues` removing 1024 issues completed **39.82% faster**, in the controlled native-browser fixture.

| Workload                                 | Baseline median / MAD | Result median / MAD | Decision                                     |
| ---------------------------------------- | --------------------: | ------------------: | -------------------------------------------- |
| Full org refresh, 1024 issues            |      178.30 / 3.15 ms |    138.40 / 3.50 ms | Primary accepted, −22.38%                    |
| Clear org, 1024 issues                   |      104.60 / 5.65 ms |     62.95 / 1.40 ms | Secondary accepted, −39.82%                  |
| Workspace refresh, 256 issues            |       40.00 / 0.50 ms |     30.35 / 0.35 ms | Scope guard passed                           |
| Empty workspace response, 256 old issues |       21.95 / 0.95 ms |     12.55 / 0.80 ms | Deletion guard passed                        |
| Single issue                             |        0.85 / 0.05 ms |      0.70 / 0.05 ms | Guard passed; no sub-millisecond speed claim |

One warmup and ten measured samples per variant/workload, alternating variant order on each pair: 100 measured observations, none removed. The primary 39.90 ms reduction exceeds both the preregistered 10% improvement and 7.00 ms noise threshold (twice the larger MAD); the clear-path 41.65 ms reduction exceeds 11.30 ms noise. Original source was frozen and a separate pre-edit warmup/pilot passed at 175.30 ms before production edits. `raw.json`, `metrics.json`, and `pilot.json` preserve evidence. Tool JSON places browser data under `data.result`.

## Mechanism and correctness

The parent changed existing-row discovery in `replaceCollabIssues` and `clearCollabIssues` from loading, decrypting and sorting complete issue bodies to existing indexed `primaryKeys()` queries. A workspace scope uses the existing `[orgId+workspaceId]` compound index; an org scope uses `orgId`. Bulk deletion, bulk persistence, transaction boundaries, public result, data schema and wire protocol remain unchanged. `listCollabIssues` still performs its normal sorted content read for UI consumers.

Primary old-body query materialization fell **1024 → 0** while returning the same 1024 identities. Every refresh still writes 1024 rows, and fixed client response bytes remain **4,518,544**. Clear still deletes 1024 rows. Workspace baseline read 257 body rows because another org shares the workspace id; result reads only 256 primary keys from the precise compound scope. These counters cover DBCore query results, not all browser allocations or middleware internal reads.

Every measured sample decrypts the final contents and compares all fields, including id, organization, workspace, body, title, board order, revision, timestamps and public count. Same-workspace rows owned by another org and sibling-workspace rows owned by the same org remain intact. Empty responses remove every stale scoped row. A separate raw IndexedDB read confirms issue content remains encrypted and title/body are absent outside the envelope.

Native failure guards (`guards.json`) verify both implementations reject a locked content cipher before any mutation. A write failure injected after deletion rolls back the transaction to the exact original rows. Parent focused tests additionally cover empty-string workspace scoping and collection behavior. The parent reported 42 focused tests across 3 suites passing. Deletion callback order can differ from old board sorting; there are no known first-party hooks relying on that incidental ordering, and no hook-order equivalence claim is made.

## Runtime and boundaries

Actual public production sync/mirror modules, complete `CogniaDB` schema and account encryption middleware run on Chromium 151 native IndexedDB and WebCrypto. Each sample has a fresh synthetic account database/key, deleted after verification. The mirror is server-authoritative and excluded from companion/account-sync capture by design; no capture behavior is bypassed. Client responses are deterministic in-process fixtures: network transit, authentication, remote server time, rendering, Tauri/Capacitor engines and real device transfer are excluded. This establishes local durable mirror refresh performance, not end-to-end WAN latency.

The full-schema bundle includes a search-indexer adapter whose exports throw if called; this issue flow does not call them. Node builtins remain external in deferred chunks and would fail visibly if exercised. Build environment is fixed to production and otherwise empty, with the existing shared-chat flag copied from the prior harness; it does not affect issue sync. Runtime network audit records only GET requests to isolated localhost port 18750, no external requests and no browser errors (`runtime-audit.json`). CPU power/thermal state was not pinned. Benchmark timing was coordinated serially with other agents; no parallel build or test ran during the final suite.

## Reproduction

From repository root:

```sh
rtk proxy node docs/reports/multi-device-performance-2026-10-08/collab-issue-keys/build.mjs
rtk proxy python3 -m http.server 18750 --bind 127.0.0.1 --directory /tmp/cognia-collab-keys-2026-10-08
```

In a second terminal:

```sh
rtk agent-browser --session cognia-collab-keys open http://127.0.0.1:18750
rtk agent-browser --session cognia-collab-keys eval 'window.runBenchmark()'
rtk agent-browser --session cognia-collab-keys eval 'JSON.stringify({progress:window.benchmarkProgress,error:window.benchmarkError,done:!!window.benchmarkResult})'
rtk proxy agent-browser --session cognia-collab-keys eval 'window.benchmarkResult' --json
```

After reloading the page, use `window.runBenchmark("guards")` for failure/locked-cipher guards or `window.runBenchmark("pilot")` for the original-only pilot. Build embeds frozen baseline mirror and sync source through an isolated resolver, alongside current production modules. `result-collab-issue-mirror.ts.txt` and `source-hashes.json` identify the measured result. All saved source remains `.ts.txt` outside app/docs compilation. No production source was edited by this benchmark subtask.

Validation: benchmark bundler ESLint and artifact diff whitespace checks passed. Dedicated browser session was closed and localhost server stopped after all artifacts were saved. Temporary browser bundle remains under `/tmp/cognia-collab-keys-2026-10-08` for reproducibility.
