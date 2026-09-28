# Pi import conversion performance

`parsePiSession` now constructs one parse-local parent index and reuses it for
all alternate branches. It also reuses the already-computed active chain when
enumerating alternate leaves. Indexing changes from O(entries × branches) to
O(entries); walking/outputting every branch's ancestors remains necessary and
unchanged. There is no cross-file or cross-import cache.

| File read + complete conversion | Before median | After median |  Before / after MAD | Reduction |
| ------------------------------- | ------------: | -----------: | ------------------: | --------: |
| 12,010 entries, 1,000 branches  |   294.0766 ms |   24.4958 ms | 14.9150 / 1.8512 ms |    91.67% |
| 12,010 linear entries           |    22.9554 ms |   19.4693 ms |  0.6217 / 0.5420 ms |    15.19% |

Both differences exceed 10% and twice the larger MAD. The primary branch-heavy
delta is 269.5808 ms versus a 29.8299 ms noise threshold. The linear guard also
improves. These are warm-cache subsystem measurements, not complete desktop
import or UI latency.

## Method and preservation checks

- Apple M4 Pro, arm64 macOS, Node v26.5.0. Shared workstation with other builds
  active; samples alternate baseline/candidate order in one process to reduce
  time drift. Two warmups plus 12 measured samples for each build and workload.
- Deterministic real temporary JSONL files: 3,115,414 bytes (branched) and
  3,118,489 bytes (linear). Ten shared messages plus 1,000 twelve-message branches
  produce 1,000 conversations and 22,000 output messages, including shared
  history. The linear file produces one conversation with 12,010 messages.
- Production conversion and handoff projection are bundled from source with
  esbuild. Uncalled native filesystem, CLI-home, media and optional AI-summary
  boundaries are excluded from bundling; conversion functions are not mocked.
  Real Node file reading is included in the timer. GC is requested before each
  sample; fixture setup, bundling, GC and output hashing are outside the timer.
- Entire serialized conversations match SHA-256 on every warmup and measured
  sample, including IDs, metadata, continuation seeds, losses and nested branches.
  Raw hashes and source hashes are in `pi-results.json`.
- Observed median retained/transient heap delta during branched conversion:
  65.30 → 27.16 MiB; linear: 43.37 → 39.14 MiB. These are process snapshots around
  the operation, not peak allocation measurements. RSS is recorded per sample,
  but allocator reuse in the shared process prevents independent RSS claims.
- Before production edits, the same-code calibration was 291.42/294.49 ms for
  branches and 23.06/23.35 ms for linear histories; no spurious improvement.

New tests verify no full-tree re-indexing per leaf, independent later snapshots,
duplicate IDs, legacy no-ID input, cycles, dangling parents, invalid timestamps,
and 100 branches retaining their common tool results plus truncated-line notes.
All 36 session-import suites / 360 tests pass (`ts-tests.log`); scoped ESLint and
Prettier pass. Strict isolated TypeScript checking of `pi-tree.ts` and its tests
also passes. Repository-wide checking exhausted the 8 GiB heap limit before
completion (see `typecheck.log`). No outbound LLM calls, runtime ownership or
persistence changes.

## Reproduce

From the repository root, with the baseline commit still available locally:

```sh
rtk proxy node --expose-gc docs/reports/external-import-2026-09-26/pi-measure.mjs
```

The harness builds the baseline Pi files from commit
`5d48f846142312c8d344083b5240d32400b36946` and current files without changing the
checkout. Only generated fixtures are read; private user histories are not used.
Pre-registration: `pi-contract.md`. Raw samples: `pi-results.json`.
