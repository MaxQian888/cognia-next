# External conversation import and agent resource performance

**Latest: [all 11 sources, final measurements and validation limits](all-sources-report.md).**

The rest of this page records the earlier initial optimization batch. Its validation counts and IPC-surface description predate the all-source follow-up.

Follow-up requested specifically for Claude Code and Codex history:
[matched benchmarks, changes and limits](history-report.md).

Measured on 2026-09-26, Apple M4 Pro / macOS. These changes extend existing
production paths. No dependencies, persisted schemas or public IPC contracts
changed. Fixtures contain generated data, never private user conversations.

| User path / measured boundary                         | Fixed workload                                                | Before median | After median | Reduction |
| ----------------------------------------------------- | ------------------------------------------------------------- | ------------: | -----------: | --------: |
| OpenCode native SQLite read → normalize → JSON encode | 2,400 messages, 7,200 × 4 KiB tool results, 33.66 MB database |    103.854 ms |    60.160 ms |    42.07% |
| Pi file read → complete conversation conversion       | 12,010 entries, 1,000 branches                                |   294.0766 ms |   24.4958 ms |    91.67% |
| Pi linear-history guard                               | 12,010 entries                                                |    22.9554 ms |   19.4693 ms |    15.19% |
| Claude/Codex Skills catalog read → JSON encode        | 400 skills, 4,000 × 512 B text resources                      |   890.3050 ms |  332.0499 ms |    62.70% |

Each retained primary improvement exceeds its pre-registered practical threshold
and twice the larger median absolute deviation (MAD), with 12 measured samples
per variant. Pi and resource results use alternating AB/BA pairs. OpenCode uses
separate before/after processes. All comparisons retain complete output.

## Changes

- **OpenCode:** move owned JSON payloads on their final use instead of repeatedly
  deep-copying them. Duplicate/missing IDs keep the previous copy semantics.
- **Pi:** construct the parent index once per parsed file; reuse it across every
  alternate branch. Reuse active-chain discovery. No cross-run caching.
- **Skills:** read independent skill directories with at most four scoped
  workers; catalogs below eight entries stay serial. Failed thread creation
  falls back to processing that chunk, workers join before return, final sorting
  and fresh filesystem reads are preserved.

The resource metadata and base64 candidates were **discarded** because controlled
paired measurements did not establish improvements beyond noise. Large binary
resource scan speedup remains inconclusive and is not included in the table.

## Validation and scope

- Session import: 36 suites / 360 tests pass; scoped ESLint and Prettier pass.
- Native OpenCode reader: 16 tests pass; release clippy with warnings denied and
  rustfmt pass. All output bytes/checksums match. Process RSS decreased, with
  the fixture/allocator measurement limitations recorded in the native report.
- Skills: 89 tests pass, covering fresh changes/deletions, root isolation,
  resource limits, symlink exclusions and sorted concurrent output. Release
  clippy and rustfmt pass. Separate-process peak RSS is 712.91 → 673.16 MiB,
  satisfying the memory guard; this includes fixtures and allocator reuse.
- Independent read-only review found no actionable correctness or runtime-wiring
  regression in the scoped diff.
- Repository-wide `tsc --noEmit` exhausted the explicit 8 GiB Node heap limit
  (`FATAL ERROR: ... JavaScript heap out of memory`, `typecheck.log`). It did not
  finish; this is not a passing full typecheck.

These are real executions on synthetic file-backed fixtures with warm OS caches.
They do **not** measure full Tauri IPC transport, WebView rendering, Dexie writes,
remote network transfers, authenticated external agents, or end-to-end desktop
import/recovery. No claim is made that every external source or every resource
format became faster. The preceding database/crash-recovery work has separate
evidence under `../rust-database-2026-09-26/`.

## Reproduction and raw evidence

- [Native OpenCode method, raw logs and replay patch](native-report.md)
- [Pi method, production-source harness and raw samples](pi-report.md)
- [Resource experiment contract, including discarded candidates](resources-contract.md)
- [Resource results, validation and memory guard](resources-results.md)
- `resources-run.py` / `resources-compare.rs`: repeat paired real scans against
  the preserved baseline and current source without modifying the checkout.
- `ts-tests.log`: complete focused importer regression output.
- `typecheck.log`: repository-wide TypeScript check output; outcome must be read
  independently of the passing focused tests above.

No commits, staging, deployments or live user-data modifications were performed.
