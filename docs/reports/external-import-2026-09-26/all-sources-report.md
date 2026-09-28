# All 11 existing conversation-history sources — 2026-09-26

Scope is the user's confirmed existing eleven sources. Kiro, Droid, DeepSeek Harness and Devin were not added. This extends the earlier Rust database/recovery and agent-resource work; it does not replace its evidence.

## Measured changes

Times are measured elapsed milliseconds, not estimates. Unless the linked report says otherwise, fixtures are synthetic but stored in real temporary files, production source is executed, there are two warmups and twelve alternating AB/BA measured pairs, and complete normalized outputs must have equal SHA-256 hashes. OS caches are warm. These boundaries exclude Tauri IPC, WebView rendering and destination writes. Acceptance requires at least 10% improvement and a median delta greater than twice the larger MAD; guard workloads must not materially regress.

| Source / measured operation                                   | Fixed workload                         | Before median | After median | Reduction |
| ------------------------------------------------------------- | -------------------------------------- | ------------: | -----------: | --------: |
| Claude Code: read/parse/team-task resolution                  | 16 histories, 160 members, 4,000 tasks |       308.059 |      158.753 |    48.47% |
| Codex: list and complete conversion                           | 2,500 files × 8 messages               |       334.501 |      178.991 |    46.49% |
| OpenCode: list and graph conversion                           | 10,000 sessions; 128 root graphs       |       136.643 |       58.917 |    56.88% |
| Pi: file read and all branches                                | 12,010 entries; 1,000 leaves           |       294.077 |       24.496 |    91.67% |
| Gemini CLI: list and all graphs                               | 500 files × 8 messages                 |     3,254.566 |       41.602 |    98.72% |
| Gemini CLI: desktop filesystem listing                        | 2,000 files × 8 messages               |       217.785 |       67.079 |    69.20% |
| Continue: desktop filesystem listing                          | 2,000 files × 8 messages               |       153.827 |       47.807 |    68.92% |
| Aider: summary listing                                        | 60,000 turns                           |        15.964 |        7.622 |    52.26% |
| Cursor, Cline, Copilot CLI, Qwen Code: shared portable reader | 3,000 files; 2,500 root graphs         |     1,664.922 |      372.566 |    77.62% |

The last row measures their common reader with generic portable fixtures. It is **not four separately measured native-product speedups**. The Aider result measures listing; full conversion is neutral. Single-long-history and large-tool workloads generally remain neutral. Gemini's 20,000-message/1,000-rewind workload separately improves 37.54%.

The initial Gemini cache candidate regressed the single-long-file guard by 27.17%; it was rejected. A single-file fast path was added and the full matrix rerun. The old samples remain available. No threshold was relaxed. Retained heap increased about 2.33 MiB for the cached Gemini corpus and 1.93% for the portable corpus; these are post-GC snapshots, not peak-memory bounds. No constant-memory streaming claim is made.

## Correctness and recovery changes

- Reuse run-scoped indexes for parent/child/session resolution; fresh scan inputs see changed files and rejected read promises are evicted. Gemini rewinds avoid repeatedly copying the entire key set. Aider listing skips allocating full messages. Continue and Gemini desktop scans use eight bounded read lanes.
- Mixed picker imports attribute each file to its detected source, avoiding Qwen/Copilot being duplicated as Claude records. Gemini native child files and Claude teams/tasks remain attached to the correct source. Empty picked auxiliary selections never read unrelated local files.
- OpenCode accepts CLI exports and ShareNext records. Qwen preserves active and alternate branches, tool calls/results, titles and native metadata with explicit losses where runtime state cannot be reconstructed. Cline preserves nested tool results/errors and native identities/timestamps. Copilot normalizes native events without changing legacy IDs or duplicating ephemeral chunks.
- Cursor's silent 200-database and 2,000-row caps were removed; tests actually read 201 databases and 2,005 rows. OpenCode distinguishes missing optional schema from query/read failures instead of treating real errors as empty history.
- Watch batching is bounded, overflow triggers a full rescan, trailing events are retained, and stale subscriptions are ignored. Installing a watcher triggers a catch-up scan for changes made while the app was closed. Auxiliary Claude changes refresh the source graph; unrelated vendor files do not become phantom transcripts.
- Final desktop wiring inspection found plugin-fs scopes covered app data/backups but not vendor history roots. A dedicated read-only native command now serves these scanners, with native-selected roots, canonical containment and a local main-webview gate. It does not extend global filesystem write permissions. Directory type metadata avoids per-file stat IPC; missing files and real read errors remain distinct. Invalid names cannot hide valid siblings, and non-regular transcript files are rejected before text reads. Picker imports remain independent of native filesystem access.

## Validation and limits

Consolidated parser/import/hook validation: **37 suites / 450 tests pass** (`all-sources-tests.log`). Scoped ESLint, Prettier and diff checks pass. Native release clippy reports no issues and scoped rustfmt passes (`history-fs-clippy.log`). Native release importer tests: **28 passed, 1 existing manual benchmark ignored**. A harness compiles the actual native command wrapper and macro against cached real Tauri 2.11.5 dependencies and passes **6 shell tests**; the watcher helper harness separately passes **8 tests**. These test boundaries are recorded separately; passing pure parser tests is not proof of an authenticated external-agent or full desktop run. The native wrapper is registered in generate_handler and the exact build.rs ACL generator was extracted, compiled and run; its sole manifest addition is `session_import_fs`. No companion RPC is exposed. The repository-wide command-parity gate fails on two unrelated calls in `lib/connectors/lark-web/intent-client.ts` (`companion_endpoints`, `host_feature_manifest`); the new history command is registered. See `command-parity.log`.

Not verified: full Tauri startup/IPC/OS-notify E2E, authenticated provider applications, every historical/proprietary schema, cold-cache latency, peak memory for every adapter, or months-long operation. The repository-wide TypeScript check exhausted its explicit 8 GiB heap and did not complete. No dependencies, persisted schemas or real user histories were modified. The new history command is an additive IPC surface.

APFS rejects invalid UTF-8 filenames at creation: the failed fixture run is preserved in `history-fs-core-apfs-fixture-red.log`; the production name-converter test runs on Unix, while the actual invalid-name filesystem fixture is Linux-only and was not run on this machine.

Aider remains picker-only. Transcript import and crash catch-up do not recreate running agents, filesystem checkpoints or scheduler state. The separate database report describes the actual persistence/recovery guarantees and outstanding dependency issue.

## Reproduce and inspect

- [Claude final-source samples](claude-final-results.json), [method and retained earlier experiments](claude-report.md), `claude-final.ts`.
- [Codex](codex-report.md), [OpenCode final-source results and native regressions](opencode-results.md), [Pi](pi-report.md).
- [Gemini / Continue / Aider matrix, rejected candidate and guards](remaining-report.md).
- [Shared reader and native-format fixtures](portable-report.md), [watch recovery](watch-report.md).
- [Agent resource benchmark](resources-results.md), [earlier native OpenCode benchmark](native-report.md).
- [Rust database and crash-recovery evidence](../rust-database-2026-09-26/README.md).
- `all-sources-tests.log`, `all-sources-eslint.log`, `all-sources-format.log`, `fs-transport-red.log`, `fs-transport-green.log`, `fs-eslint.log`; [native core tests](history-fs-core-tests.log), [native boundary report](history-fs-report.md), [actual Tauri shell compile/tests](history-fs-shell-tests.log), and [reproduction harness](history-fs-shell-verify.py).

Earlier reports and numbers are preserved as dated experiments. For the current Claude, OpenCode and shared portable implementations use the final-source rows above, not the earlier faster/noisier estimates.
