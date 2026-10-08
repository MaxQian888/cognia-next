# Storage breakdown — one fresh snapshot

Measured2026-10-08. **Retained: performance and browser parity gates passed. Root owns final focused test/type/lint validation.**

The storage overview hook concurrently requested getStats and getHealth, but getHealth reread every table. An optional supplied snapshot lets the hook derive health from the same fresh stats on mount and refresh. Standalone getHealth still obtains fresh stats. No cache, approximation, schema change, write or weakened encryption.

| Message rows | Boundary        | Baseline median ± MAD ms | Candidate median ± MAD ms | Improvement |
| -----------: | --------------- | -----------------------: | ------------------------: | ----------: |
|           20 | mount           |                23.4 ±2.1 |                 18.8 ±0.8 |       19.7% |
|           20 | refresh         |                22.6 ±1.8 |                 18.7 ±1.1 |       17.3% |
|          100 | mount           |                25.1 ±0.8 |                 19.9 ±0.5 |       20.7% |
|          100 | refresh         |                25.2 ±0.8 |                 19.5 ±0.2 |       22.6% |
|        3,000 | mount — primary |               169.6 ±8.5 |                 91.2 ±0.4 |       46.2% |
|        3,000 | refresh         |               161.5 ±6.2 |                 96.8 ±7.5 |       40.1% |

Primary delta78.4ms exceeds practical10% and noise2×maxMAD17.0ms. Every small/refresh guardrail improves beyond its noise threshold. No tail-percentile or memory claim.

Actual production React hook and manager, minified production React bundle (no ReactCompiler transform), native Chromium IndexedDB/WebCrypto, all381current schema tables. Heavy fixture:3,000messages×2KiB and300sessions×512B plus20settings/20backups; other tables empty. Production policies encrypted messages/sessions, metadata-only settings/backups. Real navigator.storage.estimate, actual browser branch of getNativeVectorStoreSize with real runtime-adapter probe. Native Tauri vector IPC was not exercised.

Timing includes root.render through committed stats+health, and actual manual refresh through committed stats replacement.2warmups+15AB/BA samples each variant/size on same data and key; no concurrent timing/builds. Native-browser correctness compared exact deterministic category/count/size/health outputs, fresh stats reference per refresh, ciphertext presence, and all table counts unchanged. generatedAt and native quota/usage estimates are volatile and excluded from exact raw equality; native values are retained per sample. No UI page paint, complete app startup, Tauri or Capacitor latency claim.

Standalone pre-edit baseline large mount173.1±7.5ms/refresh174.9±9.8ms is archived separately. Paired results govern acceptance; no cross-run group mixing.

Correctness evidence: red.log failed for the expected two behaviors: snapshot getHealth still reread the DB, and hook getStats called2times instead of1;29other tests passed. Candidate co-located tests additionally cover standalone fresh health, mount+refresh one-read identity, existing refresh after writes/polling, refresh failures keeping visible data, ignoring initial completion after unmount, and existing completion-order behavior for overlapping refreshes. Final green/lint/type gates are reported by root or added below.

Reproduction: `rtk node docs/reports/database-performance-2026-10-07/round-4/storage-metadata/build.mjs` captures baseline-only bundle; add `--production` for current source paired comparison. Serve `/tmp/cognia-storage-metadata-2026-10-08` on8879 and invoke window.runBaseline()/runBenchmark() in an isolated agent-browser session. Snapshots, schema, vector leaf, hashes, contract, raw JSON and metrics are adjacent. Source extraction for the vector leaf preserves its exact function body plus real runtime-adapter import; no timing stub is substituted.

Cleanup: isolated browser storage-metadata-20261008 closed and owned HTTP server8879 stopped. Temporary bundle remains for reproducibility.

Final source freeze: prettier ran on all four owned files; production manager/hook were unchanged and byte-identical to measured candidate snapshots (final-source-check.json). Only co-located tests needed formatting. No further source edits planned. Root runs combined final validation to avoid duplicate heavy suites.

Evidence clarification: `nativeTotal` (quota/usage) is retained in raw samples.
`generatedAt` is omitted from normalized comparisons and is not retained as an
individual raw field. The complete health object, including its usage percentage,
was included in the successful fixture comparisons.

Final combined validation: 16 suites / 351 tests passed, including both owned
source/test pairs and storage overview/cleanup callers. Scoped lint and formatting
passed. See the parent report for unrelated full-repository gate diagnostics.
