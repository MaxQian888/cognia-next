# Resource scan experiment contract (2026-09-26)

User path: load native Claude/Codex Skills catalog, including full resource contents and serialize the native IPC payload. `lib/claude/ipc.ts` and `lib/skills/sync.ts` use `skills_scan_dir` via native or companion catalog commands.

Primary metric: full `skills_scan_dir` + `serde_json::to_vec` duration, ms; native boundary only (not WebView rendering/network).

Platform: current Apple Silicon macOS host; Cargo release on repo-pinned toolchain. Baseline revision: 5d48f846142312c8d344083b5240d32400b36946, scanner initially clean. Same machine/workload/build/cache conditions before and after.

Fixed workloads: 400 skills × 10 × 512-byte Markdown resources; 32 skills × 8 × 128 KiB binary resources. Each includes a 27-byte SKILL.md. Data generated deterministically in a private TempDir. Two warmups, 12 measured samples per fixture; warm filesystem cache, fresh reads on every operation, no disk cache clearing.

Decision: median improves >=10% and absolute delta >2×larger MAD. Independently compare metadata reuse on small-text scan and existing base64 encoder on binary scan. Full-scan output bytes/content must match, sorted skills and resource caps preserved; fresh mutations/deletions, root isolation and symlink exclusions covered. No persistent cache, secrets, new dependency or toolchain changes. No >10% latency regression on other workload. RSS recorded for separate baseline/after runs (guardrail: no persistent cache or changed result size; process RSS growth <=10 MiB).

Command: `rtk cargo test -p cognia-skills --release --lib native::tests::benchmark_native_skill_catalog -- --ignored --nocapture --test-threads=1` (12 samples; release build and temporary fixture writes allowed).

Correctness: `rtk cargo test -p cognia-skills --lib`; targeted rustfmt check and clippy. The ignored benchmark lives next to source for repeatability; only scanner and resources-* report paths are agent-owned.

## Controlled follow-up, registered before paired run

Separate after run was noisy while unrelated next-server/JS/native builds were active; its results are retained as inconclusive. Use report-local `resources-compare.rs` to compile exact preserved baseline source and current source into one optimized binary, same dependency versions and same fixture. Alternate AB/BA within each of 12 measured pairs after 2 warmup pairs. Compare medians/MAD using the original 10%/>2MAD criteria; assert the complete serialized payload is byte-identical each pair. No running processes stopped. Command: `rtk python3 docs/reports/external-import-2026-09-26/resources-run.py`. Temporary harness binaries/fixtures clean up via scoped TemporaryDirectory/TempDir. Native scan plus JSON serialization remains the endpoint; no WebView/network claim.

## Bounded filesystem concurrency experiment

Controlled follow-up did not confirm redundant-stat or encoder wins; both optimizations removed. New single hypothesis: overlapping independent per-skill filesystem waits with at most four scoped workers reduces full catalog latency. Small catalogs (<8 skills) remain serial. Thread creation failure must fall back to complete serial work, every worker joined; final sort and payload unchanged. Same fixtures/12 paired samples/2 warmups/10% +2MAD criteria apply. Allocation guardrail measured per separate process below; no persistent cache.
