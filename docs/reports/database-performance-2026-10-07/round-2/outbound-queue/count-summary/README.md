# Count-only queue summary experiment — 2026-10-08

**Verdict: removed.** The scoped 5,000-row primary metric improved only 1.4%, below both the 10% practical threshold and measurement noise. Do not preserve this change based on the favorable secondary no-scope case. Production database helper and getQueueSummary sources restored byte-for-byte to baselines (source-hashes.json).

| Workload              | Baseline median (MAD) | Candidate median (MAD) | Assessment                                          |
| --------------------- | --------------------- | ---------------------- | --------------------------------------------------- |
| Small / 10            | 0.4ms (0.1)           | 0.3ms (0.1)            | Within noise                                        |
| Typical / 1,000       | 4.9ms (0.1)           | 4.9ms (0.2)            | No gain                                             |
| Scoped stress / 5,000 | 20.9ms (0.2)          | 20.6ms (0.5)           | 0.3ms /1.4%; below 1.0 ms noise threshold           |
| Foreign-heavy / 5,000 | 20.7ms (0.1)          | 23.7ms (2.4)           | No supported gain; within 4.8 ms noise threshold    |
| No-scope / 5,000      | 24.9ms (0.4)          | 0.3ms (0.1)            | 98.8% secondary improvement; insufficient to retain |

The candidate shared the existing exact status/account/target/legacy-mixed predicate between listByStatus and new countByStatus. getQueueSummary used five counts instead of materializing/sorting five lists. Scoped `.count()` still evaluates each row to enforce visibility, so removing retained arrays/sort did not meaningfully improve this workload. No-scope benefits from the native index count; it was a guardrail rather than the primary scenario. No schema or scope weakening was attempted.

Native Chromium 151 IndexedDB, actual middleware/policy (queue is metadata-only), 2 warmups + 15 samples per variant, alternating same-browser/DB order. Fixture 1 KiB/job; extra sent and legacy failed rows excluded. Exact independently expected scoped/no-scope count objects and unchanged table cardinality validated every sample. Foreign-heavy returns 50 out of 5,000 scanned rows. No heap/UI/network/device performance claim.

Measured boundary is getQueueSummary's exact five database API calls and object assembly. The thin wrapper itself was not bundled. Candidate source archives include real wrapper wiring; a regression test confirmed the original wrapper calls the sorted-list path (`red.log`) before implementation. Candidate-only count/wiring tests were removed with the failed source change; existing runner tests remain. The independent scope/tie/legacy listing regression tests from the first trial remain and are validated by the parent task.

Evidence: contract.md; baseline.json measured before source edit; result.json+metrics.json for paired values; baseline/rejected full db and runner source snapshots; source-hashes.json; red.log. The standalone baseline used original list calls. After rejection the harness was changed to import the archived rejected count helper, preserving reproducibility without keeping rejected production code.

Reproduce:

```sh
rtk node docs/reports/database-performance-2026-10-07/round-2/outbound-queue/count-summary/build.mjs
rtk python3 -m http.server 8770 --bind 127.0.0.1 --directory /tmp/cognia-queue-count-perf-2026-10-08
rtk agent-browser --session cognia-queue-count-perf open http://127.0.0.1:8770
rtk agent-browser --session cognia-queue-count-perf eval 'window.runBenchmark()'
rtk agent-browser --session cognia-queue-count-perf wait --fn 'window.benchmarkResult || window.benchmarkError'
rtk agent-browser --session cognia-queue-count-perf eval 'window.benchmarkResult || window.benchmarkError'
rtk agent-browser --session cognia-queue-count-perf close
```

Browser/server stopped; successful samples deleted isolated synthetic DBs. No user database accessed. Parent task performs combined final Jest/lint/types checks; no timing assertion added to CI.
