> Historical audit snapshot: the recovery-file race and the retention mismatch described below were subsequently fixed in this task. See `recovery-results.json`, `retention-report.md`, and the main report for final status. Full-load/backup lock duration and scoped stats remain separate follow-up findings.

# Native session mirror audit and measured improvement

Owned change: crates/cognia-agent-state/src/agent_session_store/mod.rs only. All other files left untouched. No schema migration, no new persistence state.

## Accepted measurement

See rust-list-final.json and rust-list-head.log. Actual production Rust SessionStore::list_sessions vs previous SQL using bundled SQLite 3.50.2, in-memory synthetic fixtures, unoptimized cargo test profile, 1 warmup and 10 paired alternating AB/BA samples. This is not release-build or real-user disk end-to-end latency.

100000 rows / 100 sessions: 16.683375 ms -> 0.4718745 ms median, 97.1716% improvement, >2 x max MAD.
100000 rows / 1000 sessions: 16.8684585 -> 17.298438 ms, 2.549% regression.
10000 rows / 10000 sessions: 6.6532495 -> 7.143521 ms, 7.369% regression.
100000 rows / 100000 sessions: 82.73175 -> 83.460604 ms, 0.881% regression.

Acceptance pre-registered in sqlite-list-head-plan.json: primary >=20% median improvement and >2 x max MAD; sparse guardrail max(10% baseline, 0.5ms). All accepted. Unconditional recursive seeks and hybrid UNION candidates were rejected; their native/Python measurements are retained under this directory.

Implementation enumerates at most129 session heads using entries_session covering-index seeks. With <=128 sessions, returns complete sorted heads. With129 heads, runs unchanged GROUP BY baseline. Improvement is deliberately limited to projects with <=128 sessions; other catalogs pay bounded probe overhead.

Validation: cargo test -p cognia-agent-state --lib --offline:57 passed,0 failed,1 ignored benchmark. Benchmark explicitly run:1 passed. Rustfmt check and git diff --check passed. Boundary test covers0,1,127,128,129,257,513 scoped sessions, subagents, negative/tied timestamps. Recovery regression covers duplicate append retry, subkey/main deletion, normal file close/reopen. It is not a power-loss or SIGKILL test. Exact-source Python SQL harness sqlite-list-final.py adds query-plan and scope/subpath equality evidence; Python SQLite3.53.4 is supplementary, native numbers above are authoritative.

## Remaining read-only findings

1. Observability recovery is JSON, not SQLite. recovery_runtime/controller.rs:154-160 snapshots under a state lock but saves after releasing it. recovery_store.rs:76-83 always writes the same recovery-state.json.tmp then renames without save serialization. Concurrent saves can overwrite stale snapshots, race rename, or write through another save's renamed inode. Confirmed code mechanism; no native concurrency/crash reproduction was run. No file/directory fsync means power-loss durability is unproven. Existing tests cover clean reopen, corrupt JSON, and a partially written temp file only.
2. SessionStore::load at mod.rs:503 parses the entire transcript while holding its single DB mutex. backup_to at874 likewise holds it for entire backup. Confirmed serialization mechanism; no user-facing blocking latency measured.
3. prune at840 performs GROUP BY across entries on first lazy open (dispatch.rs:33-45). Exploratory exact-SQL Python medians over1000sessions: no-op prune10000/100000/300000 entries=0.908/7.430/24.374ms. Existing retention tests verify no truncation of active transcript rows.
4. prune independently deletes summaries by mtime at863. Exact production-SQL fixture confirmed old entries + recent summary -> entries0/summaries1. load therefore returns Some(empty) for that retained summary. This is a confirmed storage policy inconsistency, not a proven SDK resume failure. Recent entries + stale summary conversely lose their summary.
5. stats at905 counts DISTINCT session_id without tenant/workspace/project, undercounting catalogs containing the same session ID in multiple scopes. Diagnostic correctness only.
6. Native mirror module documentation explicitly says canonical Claude CLI JSONL remains the source of truth; mirror loss costs browsing, not the CLI session itself. Do not present this improvement as renderer Dexie recovery improvement.
