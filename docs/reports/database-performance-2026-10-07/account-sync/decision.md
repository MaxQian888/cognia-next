# Decision: do not retain

No production applier edits were made. The candidate exists only in an experiment
snapshot, never imported by production. The same encrypted IndexedDB apply operation
and result assertions ran for both variants (15 measured pairs per workload).

- 1 operations: 2.00 ms (MAD 0.20) → 1.90 ms (MAD 0.20); 5.00% improvement.
- 300 operations: 248.50 ms (MAD 117.20) → 223.30 ms (MAD 103.90); 10.14% improvement.

The 300-op samples are highly variable (raw samples preserve the entire run).
The median difference does not clear the predeclared noise rule. Therefore this
experiment supplies no reliable performance claim and does not justify a key-cache
change. All row, field-clock, cursor and empty-outbox assertions passed. No network,
full application UI, mobile WebView or real enrolled device was measured.

Reproduction from repository root:

```sh
rtk node docs/reports/database-performance-2026-10-07/account-sync/build-browser-benchmark.mjs
rtk python3 -m http.server 18743 --bind 127.0.0.1 --directory /tmp/cognia-database-account-sync-2026-10-07
rtk agent-browser --session database-account-perf open http://127.0.0.1:18743
rtk agent-browser --session database-account-perf eval 'void window.runBenchmark().catch(error => { window.failure = String(error); window.done = true; })'
rtk agent-browser --session database-account-perf wait --fn 'window.done === true'
rtk agent-browser --session database-account-perf eval 'JSON.stringify({done:window.done,failure:window.failure,samples:window.samples,userAgent:navigator.userAgent})'
```

Run the HTTP server in another terminal; inspect `failure` as well as `done`.
The baseline/candidate snapshot files are resolved relative to the actual applier
module so both bundles use the same current dependencies. Reproduction after
changing those dependencies is a new environment and may give different results.
