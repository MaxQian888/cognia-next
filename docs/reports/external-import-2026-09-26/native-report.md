# Native OpenCode session import — measured results

## Scope and result

The native OpenCode SQLite reader now transfers owned part/message/job arrays instead of repeatedly deep-cloning their contents. The public command, TS adapter shape, schema fallback, raw `data` strings, unknown fields, stable ordering, token/reasoning/cache usage, parent sessions, jobs and error behavior stay intact. Last-use indexing preserves the old behavior even when schemas contain duplicate session/message IDs or missing message IDs. No cache, truncation, source writes, dependency or toolchain changes were introduced.

Read + normalize + encode improved **42.07%** on the pre-registered workload. This is native import materialization and response encoding, **not** a claim about complete desktop import, IPC transmission, Dexie persistence or UI recovery.

| Metric                                                        |          Before |         After |           Change |
| ------------------------------------------------------------- | --------------: | ------------: | ---------------: |
| Read-only SQLite open + read + normalize + JSON encode median |      103.854 ms |     60.160 ms |          -42.07% |
| Primary MAD                                                   |        3.742 ms |      3.009 ms |                — |
| Read + normalize median (diagnostic)                          |       80.370 ms |     34.145 ms |          -57.51% |
| Diagnostic MAD                                                |        2.865 ms |      2.243 ms |                — |
| Small-sample maximum total                                    |      122.538 ms |     78.465 ms | descriptive only |
| Process maximum resident set size                             | 1,109,934,080 B | 850,280,448 B |          -23.39% |
| Process peak memory footprint                                 |   853,017,896 B | 767,788,112 B |           -9.99% |

The primary delta is 43.694 ms, above both the 20% practical threshold and twice the larger MAD (7.484 ms). Memory does not regress. The performance change is retained.

## Workload and limitations

- Apple M4 Pro, 48 GiB RAM, macOS 26.5.2 (25F84), pinned Rust 1.95, release optimized + debuginfo, existing dependency/build caches. Normal machine power settings, not a pinned or isolated performance runner.
- Fixed synthetic but **real file-backed SQLite** database: 30 sessions, 2,400 messages, 7,200 tool parts, 4,096-character output per part, child relationships, jobs and usage. Deliberately reversed insertion order exercises sorting.
- Database: 33,656,832 bytes. Complete encoded output: 61,635,619 bytes, FNV-1a64 `eb9a3027be54f2cf` in every before/after iteration. Both raw and decoded polymorphic payloads remain in the output, matching the existing contract.
- 1 warmup + 12 measured samples per revision, deterministic fixture, warm OS caches, no cache clearing. Timings exclude fixture creation, output checksum and output destruction. Native connection open, all SQLite reads, normalization and `serde_json::to_vec` are included.
- RSS/footprint cover the whole single benchmark process, **including fixture creation and allocator reuse across iterations**. They are guardrails, not isolated reader allocation measurements or repeated-run memory distributions.
- The shared workstation was active; medians/MAD document observed noise. The narrow clippy invocation was waiting for a Cargo lock during after-measurement. No tail-latency/SLA or cold-cache claim is made.
- Cursor/Cline/Copilot behavior is covered by existing tests but has no measured speedup claim from this native change. No real external account/history or desktop UI run occurred.

## Correctness

`cargo test -p cognia-agent-state --release --lib session_import::tests -- --test-threads=1`: **16 passed, 0 failed, 1 ignored benchmark**.

New regressions cover duplicate session/message IDs, absent message IDs, ignored orphan messages after valid duplicate IDs, stable equal-timestamp order, unknown nested fields, table-column precedence over polymorphic JSON, retained raw payload, read-only source byte preservation and fresh reads after later committed writes. Existing tests cover child lifecycle, tools/usage/jobs, missing databases, Cursor nested/encoded data, and corrupt/changed-schema errors in checked external readers.

`rustfmt --edition 2021 --check crates/cognia-agent-state/src/session_import.rs`: passed. `cargo clippy -p cognia-agent-state --release --lib --tests -- -D warnings`: passed (10.19 seconds; `native-clippy-release.log`). The initial debug clippy waited on an unrelated build lock and was stopped; `native-clippy.log` records that blocked attempt.

## Reproduce

Use a disposable checkout containing the final source and inline ignored benchmark. Build outside measured intervals:

```sh
rtk cargo test -p cognia-agent-state --release --lib session_import::tests::benchmark_native_opencode_import --no-run
```

Run the printed release test executable directly with `/usr/bin/time -l`:

```sh
rtk proxy /usr/bin/time -l target/release/deps/cognia_agent_state-faa0aaa292785696 session_import::tests::benchmark_native_opencode_import --ignored --nocapture --test-threads=1
```

The executable hash may differ on another machine; use the path Cargo prints. In that **disposable checkout only**, reverse `native-optimization.patch` to restore just production reader logic, leaving the exact benchmark/tests intact; rebuild and repeat for baseline. Restore the patch and repeat for after. Do not reverse patches in the shared working tree.

Raw samples and process measurements: `native-before.log`, `native-after.log`; parsed statistics: `native-results.json`; pre-registration: `native-contract.md`; focused test output: `native-tests.log`.
