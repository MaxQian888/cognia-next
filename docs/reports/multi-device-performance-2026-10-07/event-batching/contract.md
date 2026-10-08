# Event batching experiment — 2026-10-07

Registered before the production edit or baseline timing.

- User path: Companion WebSocket reconnect replay / live conversation event batching and JSON encoding. This is the synchronous server send preparation portion; socket, network, receiver, UI and physical devices are not measured.
- Hypothesis: building an intermediate `serde_json::Value` envelope clones every payload; direct borrowed envelope serialization reduces preparation CPU elapsed time without changing parsed wire data or batching.
- Primary metric: median milliseconds per 20 executions of 1,024-frame replay batching + encoding, including input cloning required by ownership.
- Guard workloads: 6,000-event synthetic live stream at 100 events/s (20 executions), and 128-frame replay with 16 KiB payloads (20 executions).
- Fixed fixture: deterministic nested JSON (Unicode, escaped quotes/newlines, null, bool, numeric fields), two alternating 128-event channel runs. Live timestamps advance 10 ms per event, without sleeping. Single-frame encoding remains a guard.
- Machine: Mac16,7 Apple M4 Pro, 48 GiB, Darwin 25.5.0 arm64; configured power mode 0, AC power at 100%. Rust 1.96.1. Other shared-tree activity may add noise; no cache reset. Agent-owned benchmarks are serialized.
- Revision: afae6923dc9d4a579d11eb8c07a23d977e0dc6a3 plus pre-existing dirty changes outside this file. This file was initially clean.
- Build: `cargo test -p cognia-companion-bus --release`; same build profile, machine, fixtures and command before/after.
- Warmup: 2 samples per workload. Measurement: 12 samples per workload; report every sample, median and MAD.
- Acceptance: primary median improves >=10%, absolute improvement >2*max(before MAD, after MAD); guard workload medians may not regress >5%. Parsed wire content, total bytes and batch counts must be identical; current immediate-first-frame, channel, order and byte/frame bounds tests must pass.
- No p95 claim from this small sample. Timing thresholds are manual evidence, never a flaky CI assertion.
- Command: `rtk cargo test -p cognia-companion-bus --release benchmark_batching_and_encoding -- --ignored --nocapture --test-threads=1`.
- Correctness: `rtk cargo test -p cognia-companion-bus event_batcher`; source-only rustfmt check; crate clippy when feasible.
- Allowed effects: edit existing `event_batcher.rs` and this report directory, Cargo compilation caches. No dependency changes, cleanup, network requests, commits, or edits to other agents' files.
