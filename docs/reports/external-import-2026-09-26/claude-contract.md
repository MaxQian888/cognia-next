# Claude Code parsing experiment — pre-registration 2026-09-26

Target: actual adapter `parseGraph` with file-backed SessionFs, including transcript reads, DAG selection, full conversion, independent child reads and team/task snapshot enrichment. No Tauri IPC or persistence claim.

Baseline: git HEAD claude-code.ts (initially clean); all other source modules identical. No DAG file changes. Build: esbuild bundled current source on Node, real fs promises, existing Node and deps, Apple M4 Pro macOS26.5.2. Warm filesystem caches; no cache clearing.

Workloads: long transcript (12000 linked user/assistant records, tools/reasoning); large tools (600 calls, 16KiB results, sidechains/abandoned branch/malformed tail); batch team histories (16 transcripts with100records, one team160members and4000task files, shared scan input per batch); small guard (20records). Fixed timestamps; include two independent child transcript segments in large-tools fixture. Measure complete sequential parseGraph batch, keeping canonical graphs. Output JSON SHA256 must agree exactly before/after.

2 warmups per variant +12 measured AB/BA paired iterations. GC outside measured range when available. Median/MAD; keep each optimization only if intended primary improves >=10% and absolute delta >2maxMAD. Non-target workload regression must not exceed10% and2maxMAD (tiny small-case tolerance0.5ms). Heap/RSS deltas sampled before/after; retained median heap must not worsen by >20%+1MiB; disclose GC/process noise. No tail SLA claims.

Hypotheses to test separately: (1) eliminate temporary per-record content/filter arrays while retaining tool-result-first semantics; (2) replace member-by-task scans with one task-owner index and avoid repeated team normalization within input-cached snapshots if (1) is inconclusive. No truncation, JSON validation weakening, redaction bypass or production global caching. Fresh SessionScanInput keeps source freshness. Regression tests must cover mixed blocks, branches/sidechains, independent children, team ownership ordering/missing fields, retry/fresh reads, long tool results and malformed tails.

Artifacts: claude-measure.mjs, claude-results*.json, claude-tests.log, claude-report.md. Temporary files removed after execution. Baseline source selected with esbuild onLoad (no edits/reverts of shared checkout). Allowed source writes only adapter claude-code.ts and colocated test.

## Guardrail amendment before final prefix-index revision

After the accepted full owner-index experiment, code review identified unnecessary full task traversal when one member matches the first task. Replace full index construction with progressive prefix indexing: extend only until either member alias matches, retain earlier owner matches for later members. Each task remains visited at most once. Add file-backed `single-owner` guard (1 transcript100records,1member,4000tasks, first task owned by member). Same2warmups+12AB/BA, equality, noise and regression rules. Preserve earlier accepted/noisy datasets, never select their best sample.

Decision: prefix-index variation was withdrawn; keep the simpler accepted full owner index unless the single-owner guard demonstrates a material end-to-end regression. Its raw measurements are retained as withdrawn evidence, not a retained claim.
