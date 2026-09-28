# Native OpenCode import experiment (pre-registered 2026-09-26)

- User path: desktop import reads external OpenCode SQLite history, normalizes full sessions, serializes command result for IPC. Benchmark covers native SQLite open/read/normalize/JSON encoding, not IPC transfer or frontend conversion.
- Hypothesis: repeated deep clones of part payloads and grouped messages dominate native materialization for long tool-heavy history. Transfer owned values on last use; duplicate IDs retain current replicated contents.
- Revision before edits: `5d48f846142312c8d344083b5240d32400b36946`; session_import.rs initially clean. Shared checkout has unrelated changes.
- Fixture: real file SQLite database, 30 sessions x 80 messages x 3 parts; 4096 ASCII characters per part, per-message tokens/cost, child sessions, jobs. 7200 parts. Generated deterministically in ignored Rust benchmark; source reader opened read-only. No source user databases touched.
- Build: existing pinned Rust toolchain, `cargo test -p cognia-agent-state --release --lib session_import::tests::benchmark_native_opencode_import -- --ignored --nocapture --test-threads=1`.
- Warm-cache benchmark: 1 warmup, 12 measured samples, same deterministic fixture and command each revision. No cache deletion. Timing includes connection open, complete read, normalize and JSON encode; fixture creation/checksum and output destruction excluded.
- Primary: native read+normalize+encode median milliseconds. Diagnostic: read+normalize milliseconds. Noise: median absolute deviation (MAD). Accept only >=20% median primary improvement AND absolute delta > twice max(MAD before, MAD after).
- Guardrails: output bytes/hash identical; all existing tests and duplicate-ID/schema/ordering regression tests pass; process peak RSS (`/usr/bin/time -l`) must not rise >10%. Small-sample maximum reported, no p95 claims.
- Filesystem side effects: test temp SQLite files removed on exit, existing target artifacts, report raw logs. No dependency/toolchain changes, user-store writes or production caching.
- Evidence: native-before.log, native-after.log, native-results.json. Focused Rust tests, rustfmt, clippy. Desktop UI and actual IPC remain unverified.
