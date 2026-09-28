# Portable history corpus indexing — pre-registration 2026-09-26

Target: complete file-backed `listSessions` followed by `parseGraph` for every listed root in a scan input. Shared portable reader powers Cursor, Cline, Copilot CLI and Qwen generic/local exports. Native format compatibility is a separate claim; no proprietary-schema support is fabricated.

Baseline: clean `lib/session-import/adapters/portable-agent-source.ts` at git HEAD before edits; esbuild loads that exact source for baseline and current source for candidate, shared dependencies identical. Production changes restricted to this adapter and colocated tests.

Hypothesis: parsed corpus caching does not prevent repeated per-reference root lookup, parent grouping and canonical-ID map construction. Caching those lookup indexes once per scan input will improve many-session complete imports without changing content or order.

Fixed file-backed workloads: many =2500 root sessions ×4 messages plus500 branch/subagent children ×3 messages, spread across3000 JSON files; long =one session with20000messages; large-tools =one session300tool pairs with16KiB outputs; small =one session4messages. Many roots include tasks/checkpoints/history/unknown redacted events and child lifecycle/lineage. Every fixture contains deterministic timestamps/IDs, no user data.

Two warmups per variant,12 measured AB/BA paired iterations. Warm FS, no cache deletion. Real Node fs reads/walks via production adapter, bounded lanes unchanged. Time includes list discovery/read/parse and every root's canonical graph construction. Hash complete outputs outside timing; exact SHA256 equality required. GC and event-loop settling outside timing; capture heap delta and retained process heap after GC. Actual-source esbuild/Node harness, not desktop IPC/UI/persistence.

Success: >=10% primary many-session median reduction and delta>2×max(MAD). Non-target guard must not regress both>10% and>2×maxMAD (small-case absolute tolerance0.5ms). Heap may not rise>20%+1MiB. No p95 claims from12samples. At least one source-specific contract test for every affected exported adapter, plus cached reads/fresh input/rejected read retry, tree order/cycle/missing refs and fidelity preservation. Existing unsupported formats reported separately.

Artifacts: portable-measure.mjs, portable-results.json, portable-tests.log, portable-report.md. Temp real-file fixture removed after measurement; no source user stores or dependency/toolchain changes. Coordinate heavy benchmark interval with parent.
