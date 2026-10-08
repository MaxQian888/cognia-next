# HostState discovery experiment — rejected, 2026-10-08

No production source was changed. The key-only candidate substantially accelerates channel discovery, but its improvement over the complete registered recovery-read boundary did not exceed measured noise. The preset decision rule rejects it.

## What actually ran

The minified browser bundle uses the actual frozen `lib/sync/host-state-store.ts` implementation. The candidate replaces only `hostStateChannels.toArray()` plus extraction of `row.channel` with `toCollection().primaryKeys()`. Both use the same inline primary key and exact session-channel regex.

The primary boundary discovers every durable session channel and reads each sequentially through the actual `getHostStateSnapshot`, matching the read segment in `settleOrphanedTurns`. It includes native IndexedDB transactions, metadata reads and complete snapshot payloads. It excludes lease acquisition/reprojection, pending-action replay, orphan mutation/summary commits and heartbeat. It does **not** measure full service startup.

Native Chromium 151.0.0.0, macOS / Apple M4 Pro, 48GiB; synthetic disposable data and warm caches. Production content-protection catalog and encryption middleware are installed. Actual policies: `hostStateChannels` and `hostStateMeta` are **metadata-only**, while `sessions` and `chatDrafts` are encrypted-content. The measured existing-channel path does not consult business sessions/drafts. This is avoided IndexedDB value hydration, **not** avoided channel decryption.

Schemas are copied exactly from current `schema.ts`; no schema version/index changes. Dependencies outside the read seam are build-only throwing sentinels: accidentally invoking one fails instead of returning a mocked result. No real user database or content was accessed.

## Paired result

15 measured samples per variant and shape after two warmups, alternating AB/BA. Median ± MAD in milliseconds; all raw data in `paired.json`, derived numbers in `metrics.json`.

| Shape / metric                                                        |     Baseline |    Candidate |        Change | Registered verdict                    |
| --------------------------------------------------------------------- | -----------: | -----------: | ------------: | ------------------------------------- |
| **Primary: 1,000 channels × 16KiB drafts, discovery + all snapshots** | 190.4 ± 28.9 | 162.8 ± 24.4 | 14.50% faster | **Noise gate failed**                 |
| 100 channels × 512B drafts, discovery + all snapshots                 |   14.7 ± 0.6 |   14.1 ± 0.6 |  4.08% faster | Within noise                          |
| 20 channels × 512B drafts, discovery + all snapshots                  |    3.0 ± 0.2 |    3.0 ± 0.2 |            0% | No change                             |
| Large discovery alone                                                 |   24.2 ± 1.7 |    1.3 ± 0.1 | 94.63% faster | Attribution only                      |
| 100-channel discovery alone                                           |    0.6 ± 0.1 |    0.2 ± 0.0 | 66.67% faster | Attribution only                      |
| 20-channel discovery alone                                            |    0.2 ± 0.0 |    0.1 ± 0.0 |    50% faster | Attribution, limited clock resolution |

The primary delta is 27.6ms, below `2 × max(MAD) = 57.8ms`. The ≥10% percentage gate passed but the noise gate did not. We did not relabel the discovery-only result as recovery improvement, rerun until passing, or keep the performance-only source edit. The 16MiB heavy draft fixture is deliberately a large-history guard, not claimed typical workload. No authoritative p95 or memory improvement is claimed.

## Correctness and source evidence

Every timed pair asserted exact ordered channel lists, complete snapshot JSON equality, unchanged host generation/cut sequence, and unchanged channel rows. Session-index and nested non-session keys were present and excluded. `correctness.json` additionally reports seven passing native IndexedDB checks: empty catalog, cross-target keys, encoded session id, malformed/non-session filters, primary-key ordering, deletion and reinsertion. The actual catalog reports metadata-only channels there too.

`rtk git diff --exit-code -- lib/sync/host-state-store.ts lib/sync/host-state-store.test.ts` returned exit code 0 after measurement. No production test or behavior change was retained. No broad Jest/native suite was rerun for a discarded experiment. Frozen before/candidate sources and SHA-256 hashes are retained. `contract.md` records the pre-registration made on 2026-10-07; measurement completed after local midnight, 2026-10-08.

## Reproduce

```sh
rtk node docs/reports/database-performance-2026-10-07/round-2/host-state/build.mjs
rtk python3 -m http.server 8877 --bind 127.0.0.1 --directory /tmp/cognia-host-state-benchmark-2026-10-07
```

In a separate terminal, use the installed `agent-browser` skill with an isolated browser session to open `http://127.0.0.1:8877`, evaluate `window.runBenchmark()`, wait for `window.benchmarkResult || window.benchmarkError`, then export `window.benchmarkResult`. `window.runCorrectness()` returns the additional correctness assertions. Each run deletes its own IndexedDB fixtures. Stop the owned server and close the isolated browser after measurement.
