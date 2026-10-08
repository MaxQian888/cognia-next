# Native browser check (registered before browser timing)

This supplements the CogniaDB/fake-indexeddb experiment with native Chromium IndexedDB and WebCrypto. It calls the production `pushOutbox` function, with an isolated Dexie database containing the sync stores and six data tables. Capture, at-rest encryption, enrollment, remote network, receiving replica and UI are outside this fixture. Rows, outbox entries and clocks are seeded before timing. The push callback acknowledges ops locally; after timing every op is decrypted and its sequence/id/title verified.

Primary workload: 8,192 queued conversation titles; full drain elapsed milliseconds. Guards: 1 and 300 rows. One warmup per variant/workload, ten measured samples per variant/workload, alternating baseline/result order between samples. Fixed device id/epoch/field clocks; same browser process and bundled modules. Baseline module is the saved unmodified pusher source resolved against its original directory, with no edits to the shared source tree.

Acceptance: primary median improvement >=10% and >2*larger MAD. Guard medians must not worsen by more than max(5%, 2 ms, twice larger MAD); wire bytes, op count and decrypted data must match. No CI timing threshold. Record UA, hardware concurrency, all samples, median and MAD. No WAN or physical-device claim.

Build with `rtk node docs/reports/multi-device-performance-2026-10-07/build-browser-benchmark.mjs`; serve the printed temporary directory over loopback only. Use an isolated agent-browser session. `window.runBenchmark()` starts the experiment; `window.benchmarkResult` or `window.benchmarkError` records completion. Delete each fixture database in finally. No user databases, credentials or production endpoints are involved. Outputs are temporary browser bundles and this report's JSON evidence.

Commands used after building (browser commands were issued separately; other benchmarks/tests were idle):

```sh
rtk proxy python3 -m http.server 18747 --bind 127.0.0.1 --directory /tmp/cognia-transfer-browser-2026-10-07
rtk proxy agent-browser --session cognia-transfer-perf-20261007 open http://127.0.0.1:18747
rtk proxy agent-browser --session cognia-transfer-perf-20261007 eval 'window.runBenchmark()'
rtk proxy agent-browser --session cognia-transfer-perf-20261007 eval '({progress:window.benchmarkProgress,error:window.benchmarkError,done:!!window.benchmarkResult})'
rtk proxy agent-browser --session cognia-transfer-perf-20261007 eval 'window.benchmarkResult' > docs/reports/multi-device-performance-2026-10-07/browser-raw.json
rtk node docs/reports/multi-device-performance-2026-10-07/summarize-browser.mjs
rtk proxy agent-browser --session cognia-transfer-perf-20261007 close
```

Wait for `done: true` and no error before exporting. Stop only the loopback server process started for this run. The reducer checks sample counts, op counts and byte equality before writing metrics. The `.ts.txt` fixture is compiled by the build helper as TypeScript and deliberately excluded from app compilation; it is not a new runtime module.
