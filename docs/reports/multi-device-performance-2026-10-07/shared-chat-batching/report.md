# Shared conversation batching — measured result

Experiment started 2026-10-07; report finalized 2026-10-08 (Asia/Shanghai).

**Accepted primary improvement: 1024 shared messages, each with approximately 4 KiB text, reached the encrypted local database and durable sync cursor 60.96% faster in this controlled browser fixture.** The public production `syncSharedSession` path ran against the actual `CogniaDB` schema, native Chromium IndexedDB, active at-rest encryption, message sync revisions and armed account-sync capture.

| Workload                       | Baseline median / MAD | Result median / MAD | Decision                                      |
| ------------------------------ | --------------------: | ------------------: | --------------------------------------------- |
| 1024-message history           |     582.50 / 10.75 ms |    227.40 / 3.00 ms | Accepted: −60.96%                             |
| Single message                 |        3.60 / 0.25 ms |      3.45 / 0.15 ms | No material regression; no speed claim        |
| Create, correct twice, redact  |        5.35 / 0.15 ms |      5.10 / 0.25 ms | No material regression; no speed claim        |
| 16 messages with creating hook |       12.80 / 0.85 ms |     12.75 / 0.15 ms | Sequential fallback preserved; no speed claim |

Each workload used one warmup per implementation, then ten measured samples per implementation, alternating execution order by sample. The history delta is 355.10 ms, exceeding the preregistered 10% threshold and 21.50 ms noise threshold (twice the larger MAD). Before production edits, a separate baseline warmup and measured pilot passed at 579.90 ms (`pilot.json`). All observations remain in `raw.json`; `metrics.json` contains medians and MADs. No samples were filtered.

## What changed and what was preserved

The parent changed only the message projection write mechanism: buffer up to 128 distinct message ids, then `bulkPut`. Flush before another event for an id already pending, preserving every intermediate write. Public Dexie creating/updating hook subscribers cause sequential writes, preserving hook observations and mutations. The queue operation is synchronous; only actual database flush I/O is awaited.

For the primary workload, message mutation calls fell **1024 → 8**, while mutation rows remained **1024 → 1024**. Every run retained all 1024 message events, messages and account outbox records, and both projection and cache cursors reached 1024. Client response bytes remained **4,491,755**. This is fewer database calls, not fewer synchronized events or bytes.

The repeated-id guard retained all four writes, final version 4, redacted parts, four cached events and account outbox revision 4. The hook guard invoked the creating hook 16 times and preserved all injected metadata mutations; both implementations used 16 message mutation calls. Every workload read messages back through the real decrypting middleware, compared exact parts, and verified raw IndexedDB message and field-clock rows were encrypted.

A separate native rollback guard injected failure in the second message mutation batch after the first batch had executed. It verified **zero partial messages, sessions, cached events, account outbox entries or field-clock rows** remained (`rollback.json`). Parent focused tests additionally cover gap rejection, prior rows, hooks, cancellation, revocation, media-reference maintenance and transaction rollback.

The parent rejected one preliminary implementation before final timing: awaiting an already-resolved native promise for every buffered row caused premature Dexie transaction completion in Jest. The corrected version buffers synchronously and awaits actual flush I/O; the parent reported all 70 shared-chat tests passing before this experiment. No final timing data came from the rejected candidate.

## Fidelity and limits

- Real public `syncSharedSession`, `getDb`, complete `CogniaDB` schema, encryption, capture, revision middleware, shared-chat mirror writers and media-reference paths; no minimal substitute database.
- Fixed in-process client returns the current shared-session/member shape and 200-event pages. Network transit, remote service execution and authentication latency are excluded.
- At-rest encryption uses native WebCrypto with fresh synthetic keys and unique account databases. These databases are deleted after every sample.
- `markSessionDirty` is replaced with a scheduling counter. Background search-index rebuilding is excluded. Unused search removal exports throw if invoked. No other application functions are stubbed.
- To bundle the complete browser dependency graph, Node builtins are external in deferred ESM chunks, and build-time environment values are fixed (`NODE_ENV=production`, shared-chat flag enabled, otherwise empty environment). Calling an unavailable host import would fail visibly. No host adapter was invoked.
- Final browser audit: **232 requests, all GET requests to the isolated localhost origin; zero external requests and zero browser errors** (`runtime-audit.json`). An initial build-environment `process.env` error occurred before the successful baseline pilot and is retained separately in `browser-errors.json`.
- Chromium 151, same machine/runtime, no parallel benchmark or build during timing. Power mode/thermal state were not pinned. MAD and alternating order control some noise but do not establish physical-device equivalence.
- This proves a controlled local shared-conversation catch-up improvement. It does not establish WAN transfer latency, production service throughput, background indexing time, app rendering, Tauri or Capacitor performance. Shared chat still requires its existing build flag and installation preference.

## Reproduce

Run from the repository root; all generated bundle files are isolated under `/tmp/cognia-shared-perf-2026-10-07`.

```sh
rtk proxy node docs/reports/multi-device-performance-2026-10-07/shared-chat-batching/build.mjs
rtk proxy python3 -m http.server 18748 --bind 127.0.0.1 --directory /tmp/cognia-shared-perf-2026-10-07
```

Keep that server running and use another terminal:

```sh
rtk agent-browser --session cognia-shared-perf open http://127.0.0.1:18748
rtk agent-browser --session cognia-shared-perf eval 'window.runBenchmark()'
rtk agent-browser --session cognia-shared-perf eval 'JSON.stringify({progress:window.benchmarkProgress,error:window.benchmarkError,done:!!window.benchmarkResult})'
rtk proxy agent-browser --session cognia-shared-perf eval 'window.benchmarkResult' --json
```

Read progress until `done` is true or `error` appears. The final tool JSON wraps the report in `data.result`. For the native failure guard, reload and invoke `window.runBenchmark("rollback")`. For the original pilot, invoke `window.runBenchmark("pilot")`.

The build always embeds the frozen original (`baseline-shared-chat-sync.ts.txt`) alongside the current repository implementation. `result-shared-chat-sync.ts.txt` and `source-hashes.json` record the implementation and harness measured here. Source snapshots remain `.ts.txt`, so they do not enter application/docs compilation. The fixture is `benchmark.ts.txt`; `build.mjs` is its reproducible bundler. No application source was changed by this benchmark subtask.
