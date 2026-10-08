# Rejected result-picker cursor experiment — 2026-10-08

**Rejected and fully reverted.** Stopping within each 500-row page improved the recent-match primary call from 2.5 to 1.5 ms (40%), but made sparse and no-match searches much slower. The current production bulk-page implementation remains unchanged. No production/test hunk from this experiment is retained.

## Caller and hypothesis

The active `^` / `@result:` source in `lib/chat/mentions/entity-sources.ts` requests 36 matches before workspace/exposure filtering and the visible 12-row cap. The host reference command shares the local reader (ADR-0157/0181). `searchChatResults` uses the existing `[createdAt+resultId]` index and 500-row keyset pages; a full page is materialized even when recent matches fill the result limit early.

The candidate retained the page boundaries, scan counter, substring/case matching, ordering and existing limit behavior, but consumed each page with `until(...).each(...)`, stopping when enough matches arrived. This avoided the unused page tail in dense-match fixtures. Reading every row with that cursor path cost more in sparse fixtures, demonstrating why fewer materialized rows alone is insufficient evidence of an improvement.

Other reviewed paths were not changed: message reads are already bounded or snapshot-aware; transcript state updates are session-scoped; media-reference reads use existing indexes; global input history has no createdAt-only index. No schema change was proposed.

## Fixed comparison

[contract.md](./contract.md) was saved before production editing. The complete actual chat-result module was bundled, with only getDb redirected to a synthetic database. Real account cipher/content middleware and the exact current indexes were installed. **The actual chatResultIndex policy is metadata-only**; these are native IndexedDB query timings, not encryption savings. Chromium 151, Dexie defaults, minified production bundle. Source snapshots are archived for both variants.

A standalone 90-sample baseline was saved before editing. The final paired run alternated variants for 2 warmups and 15 measured samples across six fixed fixtures (180 samples). Root serialized timing lanes. Synthetic rows contain a 400-character preview and search text; the largest fixture contains 5000 rows and 5109640 JSON bytes. Setup, expected results, equality checks and full-row hashing were outside timing. No production account data or caches were touched.

| Workload, limit 36                  | Before median / MAD (ms) | Candidate median / MAD (ms) | Decision                                  |
| ----------------------------------- | -----------------------: | --------------------------: | ----------------------------------------- |
| 5000 rows, one in four matches      |                2.5 / 0.1 |                   1.5 / 0.1 | Primary passes: 40% lower                 |
| 20 rows, one in four matches        |                 0.2 / ~0 |                   0.4 / 0.1 | Tiny timing, near noise boundary; no gain |
| 5000 rows, every row matches        |                2.4 / 0.1 |                   0.5 / 0.0 | Dense matches improve                     |
| 5000 rows, one in 200 matches       |               24.3 / 0.7 |                  42.7 / 2.0 | Guard fails: 75.72% slower                |
| 5000 rows, no matches               |               24.6 / 0.2 |                  41.5 / 0.7 | Guard fails: 68.70% slower                |
| 5000 rows, matches begin after 3000 |               17.2 / 0.7 |                  27.0 / 1.3 | Guard fails: 56.98% slower                |

The sparse increase of 18.4 ms exceeds both 10% and twice the larger MAD (4.0 ms); no-match and late-match increases also clearly exceed their bounds. The preregistered rule therefore rejects the candidate even though the primary passes. Small-fixture fractional values reflect browser timer quantization and are not used to soften the clear larger regressions.

Raw samples, returned counts, full-result hashes and exact fixture extents: [baseline.json](./baseline.json), [result.json](./result.json), [metrics.json](./metrics.json). Every measured output equals the independent sorted/page oracle, and hashes match across paired variants. No performance benefit is shipped from this trial.

## Correctness and rollback

Native correctness exercised **108 cases / 216 API calls**, comparing both implementations for tied/negative timestamps, total resultId ordering, case/empty/missing query, negative/zero/positive/fractional limits and scanLimit 0/499/500/501/NaN/Infinity. All outputs matched ([correctness.json](./correctness.json)). LiveQuery was not additionally exercised for this rejected candidate.

The deterministic row-read-budget test failed against the original implementation as expected: 500 rows read; 21 other tests passed ([red.log](./red.log)). That performance-only test was removed with the rejected source hunk, with a copy retained as evidence. No independent behavior test was added merely to duplicate the native baseline oracle. The rejected candidate's TypeScript diagnostics were not repaired or asserted: no candidate code is retained.

Rollback replaced only the exact owned hunk. `git diff -- lib/db/chat-result-index.ts lib/db/chat-result-index.test.ts` is empty, and production source bytes equal the archived baseline. [source-hashes.json](./source-hashes.json) records this check, snapshots and evidence. Root owns final shared-tree regression checks. Browser and localhost server have been closed; no commit was created.

## Reproduction

The original measurement builder is preserved as `measured-build.mjs.txt`. The reusable builder adds a source override so the rejected source can be bundled without changing production files:

```sh
rtk node docs/reports/database-performance-2026-10-07/round-4/chat-storage/build.mjs docs/reports/database-performance-2026-10-07/round-4/chat-storage/candidate-source.ts.txt
rtk python3 -m http.server 8772 --bind 127.0.0.1 --directory /tmp/cognia-chat-storage-perf-2026-10-08
rtk agent-browser --session cognia-chat-storage-perf open http://127.0.0.1:8772
rtk agent-browser --session cognia-chat-storage-perf eval 'window.runBenchmark("paired")'
rtk agent-browser --session cognia-chat-storage-perf eval 'window.benchmarkResult || window.benchmarkError || window.benchmarkProgress'
rtk agent-browser --session cognia-chat-storage-perf eval 'window.runCorrectness()'
```

The benchmark starts asynchronously; read its result after completion. Run without other timing/heavy validation. Synthetic databases are deleted in finally. The measurement excludes rendered picker latency, index flushes, workspace-title joins, network/RPC, native packaged devices and peak memory; it supports the local rejection decision only.
