# Account sync outbox experiment — 2026-10-07

User path: an enrolled device drains a backlog through production pushOutbox, including IndexedDB reads, real AES-GCM encryption and ECDSA signing, and acknowledgment settlement.
Primary metric: full pushOutbox duration (ms), excluding fixture creation and post-drain verification.
Hypothesis: bounding each outbox read before materialization removes repeated scans of the remaining backlog and improves full drain latency.
Workload: 2,048 session rows, deterministic ids and titles; fresh CogniaDB/fake-indexeddb database per sample; no at-rest encryption; one enrolled device with real WebCrypto keys; push transport acknowledges all ops without network delay.
Environment: installed Node/Jest, same macOS Apple Silicon machine; same runtime and command before/after; warm module/cache state, one warmup then ten measured samples per group. No cache cleanup.
Statistic: median, MAD; improvement must be >=10% of baseline median and >2*max(baseline MAD,result MAD). Small-sample p95/max is exploratory only.
Guardrails: every row sent exactly once with contiguous deviceSeq; plaintext payload digest matches deterministic fixture; outbox fully drained; same op count and JSON wire byte count (timestamps/key-derived fixed-length cryptographic values can change values but not size); no increase in materialized outbox rows; bounded production read <=512 eligible rows. Peak memory is not measured; retained report only stores digests and counts.
Correctness: focused pusher and account-sync integration tests, including lost acknowledgments, updates while pushing, oversize head starvation, and encryption/signature integrity.
Command: rtk proxy env ACCOUNT_SYNC_BENCHMARK=baseline pnpm exec jest lib/account-sync/data/pusher.test.ts --runInBand --testNamePattern='performance experiment' (result label for after).
Allowed changes: pusher.ts, pusher.test.ts and this account-sync report directory. No protocol, schema, debounce, network, or crypto change. Test/report outputs and Jest cache writes permitted.
Limitations: this is a complete local push-path fixture, not production network/device-to-device latency, browser IndexedDB, Tauri or Capacitor evidence; real remote service and at-rest encrypted profile remain separate checks.

Pilot adjustment before source optimization or baseline results: an 8192-row warmup had no completed sample after >2 minutes, so it was terminated and the workload reduced to 2048 rows. Sample count, correctness gates and decision rules remain unchanged.

Untimed setup seeds rows/outbox/clocks from one genuinely captured row with capture temporarily disarmed, then restores capture before drain. This isolates push-path timing from capture setup cost; production capture is unchanged and covered separately.

## Phase-shift diagnostic (registered after initial comparison)

The initial fake-indexeddb comparison worsened 3.86%; after samples shifted from26.2–26.5s to30.9–31.3s. No cause is assumed. A separate native IndexedDB alternating comparison by parent passed (+25.26%), so this diagnostic distinguishes implementation from elapsed machine/runtime drift. Run unchanged2048-row fixture with1warmup+3samples original then1warmup+3samples current. This is not a replacement acceptance experiment; keep all initial samples and rejected verdict. Frozen original copied to test-only diagnostic-baseline.ts with relative imports rewritten to existing account-sync/data modules. Production source stays optimized during diagnostic.

Commands add ACCOUNT_SYNC_BENCHMARK_SAMPLES=3; original uses ACCOUNT_SYNC_BENCHMARK_SOURCE=baseline and label diagnostic-baseline; current omits SOURCE and uses label diagnostic-result. Same timed production drain, crypto, assertions and output metrics; dynamic source selection occurs before timing.

Diagnostic correction before completed measurements: original grouped diagnostic warmup was stopped. Parent requested alternating baseline/current per pair to control drift:1warmup each and3measured pairs, one Jest process. SOURCE=paired, SAMPLES=3, label diagnostic-paired. Initial failed10+10 result remains unchanged.

Final reproducibility cleanup: frozen baseline remains only as baseline-pusher.ts.txt. run-diagnostic.mjs generates a unique OS-temp .ts module, passes its absolute path dynamically to the opt-in Jest harness, and deletes its own temporary directory afterward. The1-row loader smoke passed; no frozen .ts module remains under docs/reports.
