# Native external Skills catalog performance (2026-09-26)

Only `crates/cognia-skills/src/native.rs` changed: for catalogs of eight or more directories, scan four directory partitions with at most four scoped workers, join every worker, retain the final directory-name sort. Smaller catalogs remain serial. A failed worker-thread creation reads that partition serially. All files are read fresh; there is no persistent cache, extra dependency, or stale metadata shortcut.

The actual path is `lib/skills/sync.ts` → `skillsScanNative`/`skillsCatalogGet`, and `lib/claude/ipc.ts` native scan commands → `skills_scan_dir`; companion `skill_transactions::catalog_get` uses the same scanner. This measurement ends after native catalog JSON serialization. It does not include browser rendering, IPC transport, remote host network latency, or importing the result into Dexie.

## Comparable filesystem-backed experiment

M4 Pro, 48 GiB, macOS 26.5.2 (25F84), rustc 1.95.0. Actual unchanged baseline scanner snapshot and current scanner compiled into one optimized executable (`-C opt-level=3 -C lto=thin`, repository linker and existing release dependencies). Alternating AB/BA order, 2 warmup pairs and 12 measured pairs. Fixtures are deterministic generated files on the actual filesystem, not mocked filesystem calls. Warm OS cache; no caches cleared. Every pair asserts full serialized payload equality.

| Workload                                                      | Before median ± MAD | After median ± MAD |           Reduction | Decision                              |
| ------------------------------------------------------------- | ------------------: | -----------------: | ------------------: | ------------------------------------- |
| 400 Skills, 4,000 Markdown resources ×512 B; JSON 2,704,001 B |  890.305 ±85.498 ms | 332.050 ±36.433 ms | 62.70% (558.255 ms) | Keep: >10%, delta >2×85.498 ms        |
| 32 Skills, 256 binary resources ×128 KiB; JSON 44,783,361 B   | 275.936 ±100.566 ms | 125.999 ±47.031 ms |    Exploratory only | Inconclusive: delta150 ms <2MAD201 ms |

The binary workload was highly variable on the shared host; no binary speedup claim is made. The observed median did not regress. This is a local native-boundary result, not a production percentile or end-to-end application claim.

## Discarded candidates

- Reusing resource metadata appeared 28.19% faster in separate process runs, but the controlled AB/BA run showed only 2.0% small-text improvement, inside noise. Removed.
- Switching the hand-written binary encoder to the already-installed base64 encoder showed a 10.75% paired binary median reduction, but 12.90 ms delta <17.78 ms (2MAD). Removed.
- Initial separate after timings were contaminated by concurrent builds and a busy Next.js process. Those logs are retained as inconclusive, not presented as wins. No unrelated process was stopped.

## Reproduce and evidence

`rtk cargo test -p cognia-skills --release --lib --no-run` prepares the dependency artifacts if needed.

`rtk python3 docs/reports/external-import-2026-09-26/resources-run.py` compiles actual before/after modules with existing dependencies into a private temporary binary, then runs the paired filesystem fixture. The baseline source snapshot is in `resources-baseline.rs`; `resources-compare.rs` is the harness. All temporary files/binaries use scoped cleanup.

`rtk python3 docs/reports/external-import-2026-09-26/resources-run.py --memory` runs identical baseline/current workloads in separate processes and records `/usr/bin/time -l` output.

Raw samples: `resources-concurrent.log`; machine-readable full ledger: `resources-samples.json`. Historical candidate logs: `resources-baseline.log`, `resources-metadata.log`, `resources-after.log`, `resources-paired.log`. Pre-registration: `resources-contract.md`.

Correctness covers parallel ordering and missing SKILL.md, fresh edits and deletions, independent roots, existing per-resource size/count limits, binary bytes, nested/broken symlinks, and exact baseline/current wire equality in the full fixture. Source-level test and clippy results recorded in `resources-tests.log` and `resources-clippy.log`; final output appended below.

## Final focused verification

- `rtk cargo test -p cognia-skills --release --lib -- --test-threads=2`: **89 passed, 0 failed, 1 ignored** (the ignored test is the manual filesystem benchmark).
- `rtk cargo clippy -p cognia-skills --release --lib --tests -- -D warnings`: passed.
- `rtk rustfmt --edition 2021 --check crates/cognia-skills/src/native.rs`: passed.
- `rtk git diff --check -- crates/cognia-skills/src/native.rs`: passed.

Debug-profile cargo commands were queued behind an unrelated whole-app check, so only the owned queued test process was cancelled and the already-built release profile used. Other sessions' processes and changes were preserved. Live Tauri/WebView, remote companion delivery and real user agent directories were not exercised; tests use isolated synthetic catalogs.

Separate-process peak RSS guard (`/usr/bin/time -l`, identical fixtures and14scans per workload): baseline 712.91 MiB, current 673.16 MiB; change -39.75 MiB, within the +10 MiB guardrail. This includes fixture setup, full response allocations and allocator retention, not just worker stacks. Results are a guardrail observation, not a claimed memory optimization. Independent builds intensified during these separate runs, so their timing samples are excluded from latency conclusions; paired `resources-concurrent.log` remains the latency evidence.
