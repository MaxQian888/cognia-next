# Remaining source experiment contract — 2026-09-26

Scope: actual production Gemini CLI, Continue and Aider adapters; existing modules only.
Baseline: source snapshots remaining-*-baseline.ts captured before changes. Same dependency tree and Node/esbuild bundles for AB. macOS arm64; host metadata emitted in results. No external provider/network. Synthetic format-faithful fixtures stored in temporary real files, not users private histories. Warm OS cache, fresh input objects per run; 2 warmups, 12 alternating AB/BA samples, explicit GC before each. Median and MAD, not p95.

Hypotheses: Gemini picked graph construction reparses the entire picked corpus for every root; index it once per input and clone output per graph. Gemini rewind copies all keys even for tail removal; use insertion order plus positions. Continue desktop scan serializes independent file reads; reuse bounded8 scheduler preserving order. Aider listing builds every StoredMessage only to discard it; reuse same parser in summary mode.

Workloads: Gemini 500 root files x8 messages, list+all graphs (real file read included); long/replayed 20000 messages with1000 tail rewinds; single 20000 plain; small2x8. Continue2000 files x8 list (fs read included), long1x20000, small2x8. Aider one Markdown file60000 turns list, small16turns, end-to-end list+graph guard. Guard large tool fixture handled Gemini in long replay. Correctness full output hashes per variant with deterministic clock; no timing-only shortcuts.

Acceptance per change: >=10% median improvement and difference >2x larger MAD, no supported output difference; guards no established >10% regression. Record heap/RSS deltas and retained heap; investigate >20% or >32MiB growth. New format/detection correctness fixes separately tested and disclosed. Not Tauri IPC/webview or production wall-clock claim. Artifacts and temporary fixtures only; no dependency/lock updates. Preserve all concurrent edits. Commands: node --expose-gc docs/reports/external-import-2026-09-26/remaining-measure.mjs; focused Jest, ESLint, Prettier. Remove unproven edits.

Before first measurement amendment: Gemini desktop2000files x8 list added to measure bounded8 read hypothesis separately from picked-corpus reuse. All other conditions unchanged.

Initial candidate decision: Gemini long single-file guard regressed91.531→116.403ms (+27.17%, delta25ms>2xMAD6.676). Reject unconditional picked-cache entry. Single-file parse now uses direct parser (no sibling corpus to index) to avoid retain+clone overhead. Re-run the complete unchanged workload matrix, retaining initial raw samples. No threshold change.

Guard completion before measurement: audit found the initial harness omitted the stated large-tool guard (rewind rows contained text only). Add and measure Gemini tools=1 file×600messages/300tools×16KiB outputs; tools-pair=2 suchfiles, list+allgraphs, same12AB/BA and completehash checks. Record separately remaining-tool-guard-results.json; do not claim earlier long/rewind workload included toolpayloads.
