# Gemini, Continue and Aider — 2026-09-26

Implemented and measured against actual production adapters. See `remaining-contract.md`, baseline and measured source snapshots, executable `remaining-measure.mjs`, and all raw samples in `remaining-results.json`. Synthetic, format-faithful fixtures are written to actual temporary files and removed afterward. No private user history was copied. Node/esbuild adapter execution on macOS arm64, warm filesystem, fresh input per run; 2 warmups +12 alternating AB/BA pairs. Complete summaries and graphs hashed outside timing, every output matched. Device/runtime and byte counts are recorded in JSON. This is not Tauri IPC, browser rendering or persistence end-to-end latency.

| Workload       | Baseline median ± MAD (ms) | Candidate median ± MAD (ms) | Reduction | Decision           |
| -------------- | -------------------------: | --------------------------: | --------: | ------------------ |
| gemini-many    |          3254.566 ± 32.607 |              41.602 ± 2.219 |    98.72% | accepted           |
| gemini-desktop |           217.785 ± 36.910 |              67.079 ± 3.029 |    69.20% | accepted           |
| gemini-rewind  |            154.472 ± 3.809 |             96.482 ± 10.308 |    37.54% | accepted           |
| gemini-long    |             75.302 ± 0.290 |              76.797 ± 0.224 |    -1.99% | neutral / no claim |
| gemini-small   |              0.372 ± 0.027 |               0.393 ± 0.022 |    -5.75% | neutral / no claim |
| continue-many  |            153.827 ± 6.697 |              47.807 ± 1.403 |    68.92% | accepted           |
| continue-long  |              7.220 ± 0.451 |               6.874 ± 0.481 |     4.78% | neutral / no claim |
| continue-small |              0.315 ± 0.018 |               0.260 ± 0.022 |    17.52% | accepted           |
| aider-scan     |             15.964 ± 0.571 |               7.622 ± 0.382 |    52.26% | accepted           |
| aider-small    |              0.210 ± 0.022 |               0.185 ± 0.012 |    11.86% | neutral / no claim |
| aider-full     |            119.877 ± 4.894 |            118.886 ± 12.922 |     0.83% | neutral / no claim |

Workloads: Gemini batch=500 histories×8 messages, actual reads+list+all graphs; desktop=2000 files×8 messages, directory walk/read/list. Rewind=20000 messages +1000 remove/reappend tail operations, list+graph. Long=20000 plain messages, list+graph. Continue desktop=2000 files×8 messages; long=1×20000, list only. Aider=one Markdown file60000 turns; scan=list only, full=list+graph. Small guards are in the contract and raw data. No p95 or production-user-history claims.

Changes retained:

- Gemini indexes picked sibling histories once per scan input, clones returned parsed objects for mutation isolation, and keeps single-file imports on the direct path. Rewind uses insertion positions and tail deletion rather than copying every message key on each rewind. Desktop reads use existing bounded8 scheduler and preserve listing order/error behavior.
- Continue reuses bounded8 reads, preserving discovery order and skip-on-read-error behavior. `sessions.json` is now excluded by basename before disk read.
- Aider reuses the same transcript parser in summary mode, counting nonempty turns without allocating StoredMessage objects. Full imports retain the existing parser/output.

Rejected initial candidate: unconditional Gemini picked caching regressed the long single-file guard from91.531ms to116.403ms (+27.17%). Its raw samples remain in `remaining-initial-results.json`. The final candidate avoids the unnecessary cache/clone for one file; final long guard75.302→76.797ms (+1.99%). The threshold was not relaxed.

Memory: raw per-run heap/RSS deltas and post-GC heap deltas are retained. They are process snapshots, not peak RSS measurements; allocation/GC noise can produce negative deltas. Gemini's cached many-file corpus adds approximately2.33MiB to the median post-GC delta difference, below the predeclared32MiB investigation bound; it is scoped to the import input WeakMap and released with that input. Do not interpret this as a peak-memory bound on arbitrary-size histories.

Correctness additions: Gemini detects complete Content[] and recording JSON exports, recognizes child JSONL without projectHash so mixed imports retain subagents, skips scalar/corrupt JSONL fragments, and tests duplicate IDs/inclusive rewind/checkpoints and mutable-output isolation. Mixed picker inputs are attributed to sources once and reused for both listing and graph parsing, preventing portable-family cross-labeling/duplication. Claude auxiliary paths outrank weak text guesses. The focused regression log and scoped lint log are included; consolidated all-source verification is in all-sources-report.md.

Limits: input-scoped caching assumes picked input is an immutable import snapshot (new selection/watch run creates a new input). One huge file still requires parsing its content; these changes do not add streaming JSON or promise constant memory. No full desktop shell, live provider database, or global TypeScript validation claim.

Additional large-tool guards (initial harness omission disclosed in contract):

- gemini-tools: 72.730 ± 0.680 → 72.912 ± 0.384 ms; neutral. Full output hashes identical.
- gemini-tools-pair: 147.553 ± 1.160 → 146.298 ± 0.868 ms; neutral. Full output hashes identical.

Each file contains600messages with300×16KiBtool outputs. The pair case contains2files and exercises cached corpus/cloning; single uses the direct path. Raw data: `remaining-tool-guard-results.json`.
