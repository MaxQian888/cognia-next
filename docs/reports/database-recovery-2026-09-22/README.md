# Database performance and recovery evidence, 2026-09-22

This folder contains the reproducible isolated browser benchmark, raw samples, source snapshots and native SQLite evidence. The parent report is `../database-recovery-2026-09-22.md`.

## Reproduce

Run from the repository root with the existing installed dependencies and Playwright Chromium:

```sh
rtk node docs/reports/database-recovery-2026-09-22/run.cjs baseline
rtk node docs/reports/database-recovery-2026-09-22/run.cjs optimized
rtk node docs/reports/database-recovery-2026-09-22/compare.cjs
rtk node docs/reports/database-recovery-2026-09-22/paired.cjs
rtk node docs/reports/database-recovery-2026-09-22/run.cjs optimized --recovery-only
rtk cargo test -p cognia-agent-state --lib --offline benchmark_list_sessions -- --ignored --nocapture --test-threads=1
rtk python3 docs/reports/database-recovery-2026-09-22/sqlite-list-final.py
rtk python3 docs/reports/database-recovery-2026-09-22/prune-benchmark.py
```

The browser script writes results beside itself. Re-running replaces the corresponding JSON files. `COGNIA_ROOT` can override the repository root. Only isolated temporary Chromium contexts and the database name `cognia-isolated-performance` are used; the real application database and user browser profile are never opened. Generated `.bundle.js` files are disposable and are not included in this evidence snapshot.

`baseline/lib/` captures the production persistence sources before the implementation edits. `baseline/hooks/chat/stream-coalescing.ts.txt` is the clean HEAD version from task start. All archived source files use `.ts.txt` or `.rs.txt` extensions so the docs package cannot typecheck archived code. An esbuild virtual-module loader preserves original import resolution without changing archived bytes; `archive-manifest.json` records the archived TypeScript hashes. The harness captures the selected messages and coalescing sources before bundling, then writes their exact `.ts.txt` copies and hashes. Frozen optimized source SHA-256 values:

- `lib/db/messages.ts`: `f0cfc8e81c670ea9e3827c380bbbc781284b78829a9e88817237ce09af3d8888`
- `hooks/chat/stream-coalescing.ts`: `5da43a596a9a9634278acabec0cd7960ab3f9480a04661fcd74c5c05b11643c7`

## Browser protocol

The benchmark uses real headless Chromium IndexedDB and Dexie 4.4.5. It retains production `messages.ts`, `session-assets.ts`, `normalize-message-media.ts`, `message-media.ts`, `message-media-refs.ts` and the unchanged message-sync middleware. The reduced schema keeps the production message/session/reference indexes. Each workload replaces the previous isolated dataset, limiting disk consumption.

Schema bootstrap and `withDbReopenRetry` are harness substitutes. Search indexing, workflow dispatch, claim revocation and transcript publication are stubbed external side effects. Unused original-blob ingestion/materialization and RAG functions reject if unexpectedly invoked. This benchmark does not include encryption middleware, schema migrations, Tauri, application UI or full application startup.

Workloads contain 1,000 or 10,000 messages, each with 2,048 ASCII text bytes. Separate attachment workloads add one file part per row referencing one of 16 existing shared media hashes. There are no downloads or image Blob payloads. The sequence is seed, two warmups and ten measured samples for each operation: unchanged full persist, full persist with trailing-row change, streaming trailing-row update, recent-80 restore and full restore. Input preparation is outside the measured interval; awaited persistence work and IndexedDB IO are inside it.

The practical threshold was fixed before implementation: median improvement at least 20% and absolute median difference greater than twice the larger MAD. `comparison.json` and `comparison.md` report every metric, including adverse outcomes. The comparison uses a 0.000001 ms numerical epsilon to avoid floating-point noise turning exact threshold equality into a strict inequality.

## Frozen-source browser result

Attachment-reference streaming at 10,000 rows fell from 3.70 ± 0.25 ms to 0.60 ± 0.10 ms (median ± MAD), an 83.78% improvement. At 1,000 rows it fell from 1.30 ± 0.15 ms to 0.80 ± 0.15 ms, a 38.46% improvement. Both pass the registered threshold. Actual Dexie hooks show unchanged references now cause zero creating/updating/deleting mutations; the baseline caused one delete and one create.

Full-transcript persistence and full restore did not meet the improvement threshold. The 10,000-row attachment recent-80 read increased from 0.70 ± 0.05 ms to 0.95 ± 0.05 ms, a 0.25 ms / 35.71% observed regression crossing the threshold. The read implementation was not changed, but this observation remains in the report; the run does not establish a blanket absence of performance regressions.

A targeted follow-up, [paired.md](paired.md), tested both frozen variants in the same Chromium instance using separate isolated contexts, two warmups and 30 alternating AB/BA pairs. Recent-80 reads were 0.70 ± 0.10 vs 0.70 ± 0.10 ms at 1,000 rows and 0.80 ± 0.20 vs 0.85 ± 0.20 ms at 10,000 rows. The paired median difference was zero for both sizes, and neither crossed the regression threshold. The original recent-read penalty did not reproduce under these interleaved conditions. Streaming remained faster: 1.30 ± 0.10 to 0.55 ± 0.05 ms at 1,000 rows, and 4.10 ± 0.40 to 0.75 ± 0.15 ms at 10,000 rows (57.69% and 81.71% reductions respectively). All 30 pairs, ordering and differences are retained in [paired.json](paired.json); [paired.cjs](paired.cjs) reproduces the follow-up without modifying product source.

## Recovery and concurrency checks

Every workload checks row count, first/last text, reference count, recent-window count/order and durable sync clock after a fresh page reload. A real IndexedDB transaction intentionally mutates a message, reference and session, then throws: all three plus the middleware sync clock must roll back. A real Chromium renderer crash (`Page.crash`) is followed by opening a fresh page and checking committed rows, references and clock.

The continuous-stream experiment uses the actual `SessionCoalescingRegistry`: immutable transcript snapshots arrive every 10 ms and use a 300 ms debounce. Every persistence callback invokes production `persistStreamingMessages`. At approximately 3.15 seconds, the renderer is crashed while the interval remains active; no stop or flush occurs first. The baseline produced 315 events with no interim checkpoint and recovered token 0. The frozen optimized run produced 315 events, committed tokens 101/202/303 and recovered token 303, with 12 observed events lost and 121.3 ms observed lag. Both retained 1,000 message rows and 1,000 reference rows. Repeated recovery-only results are separately recorded in `optimized.recovery.json`; actual timing naturally varies.

`optimized.recovery.json` also retains nine active transcripts of 1,000 messages each. It performs two warmups and ten rounds of nine concurrent streaming calls, checks all 9,000 rows and final content, and instruments `messages.where("sessionId")`. It observes zero whole-session query fallbacks while all nine transcripts remain strongly retained. The raw aggregate write timings are included; this is a correctness/performance guard rather than a nine-session baseline speedup claim.

## Native SQLite evidence

`rust-list-final.json` and `rust-list-head.log` contain production Rust `SessionStore::list_sessions` measurements using bundled SQLite 3.50.2, in-memory fixtures, the unoptimized cargo-test profile, one warmup and ten alternating AB/BA paired samples. `cargo-agent-state-final.log` records the focused native suite. `sqlite-list-final.py` is a supplementary exact-SQL query-plan/equality harness using Python's SQLite, not the source of the native performance claim.

The accepted native result is 100,000 rows / 100 sessions: median 16.683375 to 0.4718745 ms, a 97.17% reduction. Larger session catalogs use a bounded probe then the previous aggregate query; their 0.88–7.37% regressions remain in the raw report and satisfy the separately registered sparse guardrail. `sqlite-list-head-plan.json` contains that criterion. `sqlite-agent-audit.md` records remaining findings and rejected experiments. Exploratory Python SQL candidates and plans are retained for traceability; they are not the accepted production implementation.

## Retention correction and regression evidence

[retention-report.md](retention-report.md) records the final SQLite retention correction. The initial targeted reproduction produced three expected failures in [cargo-retention-red.log](cargo-retention-red.log). After the fix, [cargo-retention-final.log](cargo-retention-final.log) records 62 passing tests, zero failures and one explicitly ignored benchmark. Exact-SQL paired prune measurements and their registered guardrail are retained in [prune-benchmark.json](prune-benchmark.json) and [prune-measurement-plan.json](prune-measurement-plan.json); [prune-benchmark.py](prune-benchmark.py) reproduces them from the archived pre-fix source and current product source. The native list-query benchmark was not changed by the retention correction.

## Evidence limits

These are synthetic local subsystem measurements, not authenticated application UI, deployed performance or release-build latency guarantees. Renderer crash is not browser-process termination, OS crash, filesystem failure or power-loss durability. The observed checkpoint lag is not a universal disk-commit deadline. Existing-reference file parts do not measure large binary attachment ingestion or image decoding. Ten local samples and sub-millisecond browser timer granularity limit precision, especially for recent-window reads. Production schema reconnect/retry behavior and encrypted persistence require separate validation.
