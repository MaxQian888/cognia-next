# Companion WebSocket batching and encoding — 2026-10-07

Kept the optimization: `encode_ws_batch` now serializes an envelope borrowing the existing frames. Previously `json!` converted the complete frame/payload tree to an intermediate owned `Value` before encoding it again. The public API, batching policy and byte-budget calculation are unchanged.

This measures **server CPU preparation for Companion WebSocket live events and reconnect replay**. The production caller is `crates/cognia-companion/src/ws.rs::send_ws_batch`. WebRTC uses another envelope encoder and does not receive this optimization. No socket, network, receiver or UI latency improvement is claimed.

## Comparison

Apple M4 Pro / 48 GiB / macOS Darwin 25.5.0, AC power, normal power mode, Rust 1.96.1, repository release profile (optimized, thin LTO, one codegen unit). Two warmups then 12 samples per workload; each sample repeats the workload 20 times. The measured path includes input cloning, actual `EventBatcher` / `chunk_replay`, payload-size serialization, and actual `encode_ws_batch`. Live time is synthetic (10 ms between supplied timestamps), so elapsed values measure processing rather than 60 seconds of waiting.

| Workload                              | Baseline median ± MAD (ms / 20 workloads) | Result median ± MAD |  Reduction | Batches / bytes per workload, unchanged |
| ------------------------------------- | ----------------------------------------: | ------------------: | ---------: | --------------------------------------: |
| Replay: 1,024 frames, 256-byte text   |                          30.0204 ± 0.1140 |    17.0899 ± 0.1155 | **43.07%** |                             8 / 476,194 |
| Live: 6,000 frames at synthetic 100/s |                         195.2238 ± 0.6013 |   111.8467 ± 0.9003 | **42.71%** |                       1,238 / 2,907,923 |
| Replay: 128 frames, 16 KiB text       |                          28.5186 ± 0.2273 |    24.0969 ± 0.1488 | **15.50%** |                           9 / 2,124,482 |

Per-workload replay preparation falls from about **1.501 ms to 0.854 ms** on this machine. This absolute scale matters: the percentage is not a claim that cross-device transfer or first-token latency improves by 43%.

All three reductions exceed the registered 10% threshold and twice the larger MAD; both guard workloads improve instead of regressing. Total bytes and batch counts are identical for every recorded sample. The preregistration is in `contract.md`; raw observations are in `baseline.log` and `result.log`; `metrics.json` contains raw samples and computed decisions. `summarize.py` recomputes metrics from those logs.

An initial result run potentially overlapped another agent's 600-row correctness test. It is retained as `result-contended.log` and excluded from the comparison above. The complete result run was repeated after that agent explicitly confirmed it was idle. No benchmark cache reset or dependency change was used.

## Correctness and limitations

- Validation actually run: focused release tests **12 passed**; full `cognia-companion-bus` release suite **141 passed, 1 ignored**; release Clippy for all crate targets with `-D warnings` passed; source-only rustfmt check passed.
- Existing immediate-first-frame, 50 ms window, quiet-to-idle, channel boundary, stale-window ordering, control drain, 256-frame bound and 256 KiB byte-bound tests pass.
- Added a regression comparing parsed output with the old `json!` envelope for empty, single and multiple frames, nested Unicode/escaping/null/bool payloads and u64/i64 extremes. Byte lengths match; private `target_device_id` routing data stays absent. JSON object key order can change; parsed semantics stay identical.
- Singleton encoding still calls the identical `serde_json::to_string(single)` branch.
- No p95, RSS, battery, sustained network throughput, slow-phone, real reconnect or physical multi-device claim follows from this CPU benchmark. Shared machine scheduling remains a measurement limitation, despite serializing agent-owned timed runs.

## Reproduction

Run from repository root:

```sh
rtk cargo test -p cognia-companion-bus --release benchmark_batching_and_encoding -- --ignored --nocapture --test-threads=1
rtk proxy python3 docs/reports/multi-device-performance-2026-10-07/event-batching/summarize.py
rtk cargo test -p cognia-companion-bus --release event_batcher -- --skip benchmark_batching_and_encoding
rtk proxy rustfmt --check --edition 2021 crates/cognia-companion-bus/src/event_batcher.rs
```

`production.patch` contains only the production optimization. In an **isolated checkout containing the tests**, reverse that patch to recreate the baseline encoder, run the same release benchmark, then apply the patch forward to measure the result. Do not reverse patches in a shared dirty checkout. Save command output to `baseline.log` and `result.log` before rerunning `summarize.py`; the manual timing test has no flaky CI wall-clock assertion.
