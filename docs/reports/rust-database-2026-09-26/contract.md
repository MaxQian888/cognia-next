# Registered experiment — 2026-09-26

User path: restoring a long native mirrored transcript or backing it up while another conversation appends; process restart recovery.
Primary metric: append latency during full production load/backup (ms). Secondary: full load, backup, list, open+prune+load latency.
Device: Apple M4 Pro, 48 GiB, macOS Darwin 25.5.0; rustc 1.95.0; workspace release profile, bundled SQLite, local APFS temp files.
Baseline revision: f28694466f3a1de25abe2c512385ceef54cce6de (agent-state initially clean).
Fixture: 20000 transcript entries, each 4096-byte text plus UUID/type; 1000 short sessions, explicit tenant/workspace separation; real file-backed WAL, FULL durability unchanged. No network/provider.
Warm state: one warmup, 10 measured samples per operation; process reopen is OS-cache-warm, NOT physical cold disk. No cache cleanup.
Comparison: median/MAD, improvement >=10% and absolute delta >2*larger MAD. Guardrails: uncontended load/append <=10% regression beyond noise; no schema/data loss; process-kill recovery retains acknowledged writes and rolls back partial transactions. Memory bounded to one large read, no unbounded pool; record file/WAL size and process RSS.
Concurrency measurement: launch large read/backup then append after 2ms; record read completion and append latency independently. Also deterministic snapshot/lock tests, not timing performance gates.
Commands: cargo test -p cognia-agent-state --release benchmark_recovery_contention -- --ignored --nocapture --test-threads=1; cargo test -p cognia-agent-state --lib; focused clippy/rustfmt.
Allowed writes: scoped agent-state code/tests; /tmp/cognia-rust-db-2026-09-26 evidence/fixtures; Cargo build cache. Never mutate real user databases.
Evidence limits: native production store methods, not renderer/IPC/provider end-to-end. 10-sample tails are not production p95. Process SIGKILL is not power-loss testing.

## Review corrections recorded before the final run

The first exploration used a 2 ms delay, which did not prove overlap. Those numbers are superseded. Final measurement uses a zero-capacity channel from inside the load/backup after its lock/snapshot is held, checks the read is still active, and limits completion to 30 seconds.
Two identical minimal release harnesses compile the production module from the baseline revision and current checkout. Both include identical test-only observation hooks and the same benchmark. Dependency versions, release settings and fixtures match. Build completes BEFORE measurement. Final AB/BA cohorts each include one warmup and 10 samples: 20 samples per variant. macOS /usr/bin/time -l captures peak RSS of each test process, excluding compiler memory. No repeated attempts selected by outcome; all four cohorts are retained.
An earlier synchronized exploratory run overlapped with our checks and showed an uncontended append guardrail breach (0.229 -> 0.325 ms). It is retained as exploratory evidence. Final AB/BA measurement controls variant ordering and separates our compilation/checks from timing. Only final measurements are used for accepted performance claims.
