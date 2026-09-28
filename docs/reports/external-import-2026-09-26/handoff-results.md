# Shared handoff projection screening (2026-09-26)

Result: **no production change retained or made**. Source inspection identified that `buildHandoffContext` joins the entire projected transcript before comparing with the12,000-character imported branch-seed budget. However, the actual Claude file-read/parseGraph path is dominated by other work.

## Diagnostic profile

The harness bundles the current real Claude adapter and unchanged shared handoff source. It injects timing around the entire `buildHandoffContext` function only in a private generated bundle, leaving all repository runtime sources untouched. Actual fixture files are read from disk via Node filesystem APIs; parser, conversion and graph construction execute normally. Nodev26.5.0, M4 Pro. Two warmups then one diagnostic profile sample per workload:

| Fixture                                              | Entire file read + parseGraph | Whole handoff projection | Share |
| ---------------------------------------------------- | ----------------------------: | -----------------------: | ----: |
| 1,800records,600 ×16KiB tool results,10,275,066bytes |                     171.027ms |                  3.192ms | 1.87% |
| 300records,100 ×512KiB tool results,52,502,333bytes  |                     747.833ms |                 12.028ms | 1.61% |
| 20small records,4,780bytes                           |                       0.586ms |                  0.023ms | 3.86% |

Each parseGraph invoked shared handoff exactly once. These are **diagnostic samples, not an accepted before/after performance result**. They do not support spending complexity on a performance-only bounded-join change: even the complete projection was a small fraction of these measured paths, while the proposed optimization would remove only one of its operations. No speedup is claimed, and no production source/test modification was needed.

The full12AB/BA comparison runner is available in `handoff-measure.mjs` for a future substantiated candidate; because there is currently no candidate, running it would compare identical runtime source. Exact source hashes are recorded in `handoff-profile.json`, and exact measured source snapshots are preserved in `handoff-baseline.ts` and `handoff-claude-snapshot.ts`. The runner uses that adapter snapshot in both arms; imported helper modules resolve from the repository checkout.

Reproduce diagnostic profile:

```sh
rtk node --expose-gc docs/reports/external-import-2026-09-26/handoff-measure.mjs --profile-only
```

Scope: native-format Claude history file read, parsing and graph construction in an optimized Node bundle. No Tauri/WebView, live provider, LLM request, auth change or user transcript access.
