# Claude Code and Codex history follow-up

The earlier OpenCode/Pi/resource results did not establish gains for Claude Code
or Codex conversation histories. This follow-up measures their actual adapters
separately, preserving complete canonical output and source freshness.

| Measured path                                           | Workload                                           |    Before |     After |  Reduction |
| ------------------------------------------------------- | -------------------------------------------------- | --------: | --------: | ---------: |
| Codex scan + file read + parse + graph construction     | 2,500 rollout files, 20,000 messages total         | 334.50 ms | 178.99 ms | **46.49%** |
| Claude Code file read + parse + team graph construction | 16 histories, 160 members, 4,000 accumulated tasks | 308.62 ms | 175.61 ms | **43.10%** |

Times are medians of 12 AB/BA samples per variant after two warmups on the same
Apple M4 Pro macOS host, using generated fixtures on the real filesystem and warm
OS caches. Every before/after pair verifies complete graph output SHA256 equality.
Both primary improvements exceed 10% and twice the larger MAD. These boundaries
exclude Dexie persistence, Tauri IPC transport, UI rendering and live agent resume.

## Why these paths were slow

Codex already cached the parsed corpus for one import input, but rebuilt the full
session-ID and parent/child indexes for each selected conversation. The indexes
now share that existing snapshot lifetime. Child ordering, last duplicate-ID
lookup, cycle bounds, late-parent attachment and retry behavior stay intact.
Watch imports still bypass the corpus; fresh scan inputs re-read source files.

Claude Code searched all tasks for every team member. In accumulated histories,
the matching task can sit after thousands of older owners' tasks. A local owner
index resolves the earliest match by name or agent ID while preserving missing
owner fields and duplicate-task semantics. The fixture has 3,840 older-owner
tasks before 160 tasks belonging to current members; it represents that specific
accumulated-history case, not a typical-user latency percentile.

## Guard cases and honest limits

- Codex single 20,000-message file: 73.80 → 75.17 ms, within noise; no speedup
  claimed. Two small files are also neutral.
- Claude ordinary 12,000-record history: 54.14 → 53.77 ms, within noise.
- Claude 600 large tool outputs plus branches/independent children/corrupt tail:
  162.33 → 163.03 ms, within noise for the owner-index change.
- Claude one member with an immediately matching first task: 136.73 → 140.75 ms,
  within noise and below the 10% regression guard.
- The per-record content/filter-loop experiment was reverted because it did not
  improve complete read/parse/graph latency beyond the threshold. A speculative
  prefix index was also withdrawn; the retained implementation is the simpler
  complete owner index.
- A preliminary profile of 10.3 MB / 52.5 MB tool-heavy Claude transcripts put
  the entire shared handoff projection below 2% of read/parse latency. The
  proposed string-join optimization was screened out without production edits;
  this one-sample diagnostic is not a speedup benchmark.
- Codex batch heap snapshots rose about 5.89 MiB, below the 10 MiB investigation
  guard; Claude retained graph heap is effectively unchanged. These are process
  diagnostics with GC/allocator limitations, not isolated peak allocations.

Do not extrapolate either result into a claim that ordinary single-file JSON
parsing, every imported source, cold disks or complete desktop import became faster.

## Detailed evidence

- [Codex method, baseline, guards and reproduction](codex-report.md)
- [Claude Code method, variants, guards and reproduction](claude-report.md)
- [Large-tool projection profile and rejected hypothesis](handoff-results.md)
- `codex-results.json`, `claude-results.json`: accepted raw samples and source hashes.
- `codex-tests.log`, `claude-tests.log`: focused adapter regression checks.

Only the two existing adapters and their co-located tests are needed for these
changes; no dependency, schema, runtime ownership or source-data write change.

## Final checks

- `jest lib/session-import --runInBand --no-coverage`: **36 suites, 372 tests
  passed**, zero failures (`history-tests.log`).
- Scoped ESLint, Prettier and `git diff --check`: passed.
- Both final adapter SHA256 values match their accepted measurement artifacts.
- Independent review found no actionable cache-lifetime, branch-order,
  task-owner or runtime-wiring regression.
- Repository-wide TypeScript checking was not repeated after the earlier
  8 GiB heap exhaustion; no full-project typecheck or live Tauri E2E claim.
- Changes remain uncommitted; unrelated shared-worktree edits are preserved.
