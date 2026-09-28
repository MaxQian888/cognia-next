# Handoff bounded-join experiment (2026-09-26)

User path: read a real Claude Code JSONL fixture from disk, parse complete imported conversation graph, including the shared 12,000-character branch seed. Primary metric is complete `claudeCodeSessionSource.parseGraph` latency (file I/O included), not isolated join speed.

Hypothesis: full-history joining creates an avoidable duplicate string, even when the complete projected text exceeds the seed budget and is discarded. Retain the same projection and full loss accounting; compute exact block lengths/separators and materialize the full joined string only if it fits. No serialization skips, message truncation, sending/LLM/auth changes.

Fixture: 1,800 records containing600 ×16,384-byte tool results; stress300records containing100 ×524,288-byte tool results; small20records with short messages. Include a malformed final JSONL line in large fixtures to retain recovery diagnostics. Deterministic timestamps/IDs; isolated files on actual disk; no user histories read.

Device: current M4 Pro48GiB macOS host, pinned repo Node runtime and esbuild optimized bundle. Snapshot current Claude adapter source for both arms so its concurrent independent change does not contaminate this experiment. Only handoff source varies. Actual disk reads every iteration; warm filesystem cache, no cache clearing.

2 warmups and12AB/BA measured pairs/workload. Medians and MAD. Keep only if >=10% improvement and absolute delta >2×largerMAD; small workload no >10% measured regression outside noise. Full graph serialized bytes/SHA256 must match baseline/candidate every iteration. Guard: retained heap no increase >10MiB; observe transient heap. Preserve errors, budgets, summaries, attachment losses, reasoning exclusion, complete message omission semantics. Focused Jest handoff/export/to-parts+source tests and ESLint/Prettier. No fullbuild/typecheck.

Allowed writes: handoff-context.ts and colocated test only if measured optimization retained; this handoff-* evidence. Temporary bundles/files cleaned automatically. First obtain profile baseline using same fixture. Failed/noise-only edits removed and documented.
