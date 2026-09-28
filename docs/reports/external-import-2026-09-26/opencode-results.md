# OpenCode import performance and native completeness (2026-09-26)

## Retained performance change

Extend the existing weak per-`SessionScanInput` normalized-session cache with first-match ID lookup, last-match ID lookup and child adjacency. Previously each selected session rebuilt the full child index and graph-state IDMap and repeated a linear lookup. Indexes now build once per import run. First-match conversation vs last-match structured state behavior on duplicate IDs is deliberately preserved; each fresh input rereads source data and failed promises are evicted.

Actual user-path boundary measured: filesystem read of OpenCode share export → picker JSON parsing → list all root sessions/content revisions → parse every selected graph. Optimized Node bundle on Node26.5.0/M4 Pro,2warmups and12measuredAB/BApairs/workload, warmfilesystemcache, freshinput/file read everyiteration. No mocked parser or graph conversion; the unused native bridge is stubbed only because this measurement uses picker files. Every listing+graph serialization matches baseline SHA256 exactly.

| Workload    |   File bytes | Before median ± MAD | After median ± MAD | Reduction |
| ----------- | -----------: | ------------------: | -----------------: | --------: |
| batch       |  8,350,018 B |  136.643 ± 1.253 ms |  58.917 ± 2.350 ms |    56.88% |
| single      |  8,350,018 B |   52.173 ± 2.549 ms |  52.551 ± 2.231 ms |    -0.73% |
| small       |      3,157 B |    0.369 ± 0.035 ms |   0.384 ± 0.038 ms |    -4.05% |
| large-tools | 10,052,821 B |  148.833 ± 0.812 ms | 148.928 ± 0.887 ms |    -0.06% |

Batch:10,000sessions (2,500roots +7,500children),2messages/session,select128roots. **56.88% accepted improvement**:77.726ms delta >4.699ms(2×largestMAD) and >10%. Single selects1root from same10k corpus; small has4sessions; large-tools has600messages/300×32KiB tool outputs. Guard workload changes are within noise and below10%; no speedup claim for them. Retainedheap guard increases by1.44MiB in batch, below10MiB limit; no persistent cross-run cache.

Exact baseline SHA256: `9d699955a730fc4bb0a71df179e92307b7942ccfa92697d5b6009fcba34107ec`. Exact final SHA256: `56a17fcff82de6b0a804661f2a64244693dfdef3587e912b0ccd763aace028db` (verified against current source after format/compatibility fixes). Snapshots: `opencode-baseline.ts`, `opencode-final.ts`. `opencode-index-results.json` is the earlier index-only experiment and is historical; `opencode-final-results.json` is the accepted final-source dataset.

Reproduce: `rtk node --expose-gc docs/reports/external-import-2026-09-26/opencode-measure.mjs`. Optional `OPENCODE_WORKLOAD` selects batch/single/small/large-tools. Private fixture/bundle directory cleans up on exit.

## Real-format support fixed

Before this change, the picker recognized legacy keyed `{key,content}` and legacy nested `{session|id,messages}` forms but rejected two official current forms:

- CLI `opencode export`: `{info:sessionInfo,messages:[{info:messageInfo,parts}]}`. Session ID/title/cwd/time and per-message role/time/model/tokens/cost now read from their correct envelopes; parts preserve error/tool/file mapping.
- ShareNext: `{type:"session"|"message"|"part",data}` records. Out-of-order parts remain grouped by messageID. Unrelated session_diff/model metadata is ignored rather than accidentally imported as sessions. Malformed envelope/message/part rows do not crash a valid remaining import.

Official source checked2026-09-26: [export.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/export.ts), [import.ts/transformShareData](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/import.ts). These links describe formats; this work did not validate a live installation or update the adapter's historical verifiedVersion claim.

## Native correctness, separate from the performance claim

`crates/cognia-agent-state/src/session_import.rs` now reads Cursor databases beyond200files and matching rows beyond2,000; former hard caps silently dropped history. Real private SQLite regression fixtures prove201databases and2,005rows are returned in full. Both tests failed at the former caps before the fix (`opencode-native-red.log`). Existing traversaldepth is unchanged; this is not an arbitrary-filesystem crawler.

OpenCode now reuses existing checked SQLite schema/row readers. Actual schema/query/row errors propagate with context instead of becoming an empty or partial history. Missing optional tables remain compatible. Private corrupted SQLite schema and message-B-tree tests verify both failure paths; prior ownership-transfer optimization remains in place. Correctness fixes do not claim new native latency gains.

## Verification and limits

-3official-format tests failed before the fix, while29existing/index tests passed (`opencode-tests-red.log`). Final focused OpenCode+db tests: **36passed** (`opencode-tests.log`). Duplicate IDs, childorder/cycles/emptyparent, sourcefreshness and failedretry regressions pass.

- Native `session_import::tests`: **21passed,1manualbenchmarkignored**; releaseclippy `-D warnings`, rustfmt and diff-check pass (`opencode-native-tests.log`, `opencode-native-clippy.log`).
- Focused ESLint and Prettier checks pass. No whole-app build/globaltypecheck.

Measured fixtures contain complete imported message/graph data and preserve byte equality, but timings exclude Dexie persistence, WebView rendering, TauriIPC and liveprovider execution. NativeSQLite correctness fixtures are actual databases; TS timing uses actualfile pickerexports. Rawlegacy OpenCode filesystemstorage directories and ShareNext non-transcript session_diff/model metadata are not newly supported by this change.
