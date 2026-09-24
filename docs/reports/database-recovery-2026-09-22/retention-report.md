# Whole-session retention correction

Changed only the existing prune transaction in crates/cognia-agent-state/src/agent_session_store/mod.rs. No schema change and no change to the measured list_sessions query.

The entry-group delete now excludes any scoped session whose summary mtime is >= cutoff. The subsequent summary delete only removes expired summaries when no matching entries remain. Therefore MAX activity across main transcript, subagents, and summary governs the entire session. Tenant, workspace, and project are included in every correlation. retention_days=0 still returns without touching either table. Return value remains deleted entry count.

Before implementation, cargo-retention-red.log records3 intended failures: recent summary lost2 old history rows; live subagent lost its old summary; scoped collision fixture removed6 history rows instead of2. Corrected first60-test run passed (cargo-retention-green.log). Final tests add expired summary-only cleanup and injected summary-delete failure rollback; final result:62 passed,0 failed,1 ignored benchmark(cargo-retention-final.log). Rustfmt and git diff --check passed.

Performance guardrail pre-registered in prune-measurement-plan.json. Exact source SQL extracted from saved before/current source, Python SQLite3.53.4, synthetic in-memory fixtures,1 warmup+10 paired AB/BA samples, transaction rollback restores each fixture. This is supplementary SQL-level evidence, not native Rust or production disk timings.

100k entries/100 sessions, recent summaries:6.893->6.879ms median.
100k entries/100k sessions, recent summaries:16.616->16.543ms median.
100k entries/1000 sessions, old summaries/live entries:7.197->7.652ms median(+6.32% for retaining summaries instead of incorrectly deleting them).
All meet pre-registered overhead guardrail max(20% baseline,1ms). Query plans use summaries primary key and entries covering index for new NOT EXISTS checks.

Files:prune-benchmark.py,prune-benchmark.json,prune-benchmark.log. The script additionally asserts the list_sessions method is byte-for-byte unchanged from before this retention correction.
