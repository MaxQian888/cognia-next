# Codex conversation-history reading and parsing

Measured on 2026-09-26, Apple M4 Pro / macOS / Node v26.5.0. Production change:
build ID and parent/child indexes once per existing input-scoped corpus snapshot,
instead of rebuilding them for every selected conversation. No additional read
cache or longer cache lifetime. Single-file watch events still read the changed
file directly; a new scan/import input reads a fresh snapshot.

## Matched results

The primary path includes filesystem enumeration, reading summaries, then reading
and parsing all selected conversations into complete canonical graphs. Two
warmups plus 12 measured AB/BA pairs, GC before each sample, warm OS cache,
identical generated files, unmocked production converters. Full serialized list
and graph SHA256 must match every iteration; hashing is outside the timer.

| Workload                              | Before median | After median | Before / after MAD | Verdict                       |
| ------------------------------------- | ------------: | -----------: | -----------------: | ----------------------------- |
| 2,500 files × 8 messages, 5,958,890 B |   334.5011 ms |  178.9906 ms | 7.0037 / 5.2710 ms | **46.49% faster**             |
| One 20,000-message file, 5,640,125 B  |    73.7976 ms |   75.1748 ms | 0.8590 / 0.3999 ms | Within noise; no gain claimed |
| Two small files × 8 messages          |     0.4310 ms |    0.4244 ms | 0.0178 / 0.0280 ms | Within noise; no gain claimed |

Primary delta 155.5105 ms clears 10% and 2×MAD (14.0075 ms). Attribution:
summary scan medians 62.216 → 61.347 ms; subsequent read/parse/graph conversion
270.190 → 116.117 ms. The scanner itself has no measured speedup from this edit.
The single long-history delta is below 2×MAD and below the 10% guard threshold.

Median heap snapshot delta for the batch is 25.98 → 31.86 MiB (+5.89 MiB), below
the pre-registered 10 MiB investigation threshold. The operation retains all
output graphs for equality checking. These snapshots include transient garbage;
they are not isolated cache size or peak allocation measurements. The cache uses
the existing WeakMap input lifetime; no persistent disk-content cache was added.

## Correctness and boundaries

New regressions cover late parent arrival attaching cached orphan children,
duplicate IDs retaining the last lookup winner and original child order,
parent cycles, missing-file retries, watch reads bypassing the snapshot and fresh
input observing later file edits. Existing tests retain tool results, token
accounting, redacted diagnostics, lifecycle/plans/goals and filesystem read
budgets. The focused Codex + filesystem budget check passes 28 tests.

Only `codex.ts` and its co-located tests changed. No database, renderer, IPC
contract, source file writes, dependency or toolchain change. Measurements stop
at adapter output; they exclude Dexie writes, UI rendering, Tauri transport,
cold-disk behavior and live external-agent resume. Fixture data is synthetic.

## Reproduce

```sh
rtk proxy node --expose-gc docs/reports/external-import-2026-09-26/codex-measure.mjs
rtk proxy node_modules/.bin/jest lib/session-import/adapters/codex.test.ts lib/session-import/fs-budget.test.ts --runInBand --no-coverage
```

The harness loads baseline `codex.ts` from commit
`10c36223d479a08efe918e7035f1c14a42ed3534` without changing the checkout. Both
variants use the same current unchanged shared dependencies. Uncalled native
host/optional AI-summary boundaries are excluded from bundling. Temporary
fixtures and bundles are removed in `finally`.

Pre-registration: `codex-contract.md`; raw samples, output/source hashes:
`codex-results.json`; same-code calibration: `codex-calibration.json`; focused
regression output: `codex-tests.log`. Baseline calibration produced no false win.
