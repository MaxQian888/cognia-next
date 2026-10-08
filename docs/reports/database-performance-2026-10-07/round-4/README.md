# Database optimization round 4 — 2026-10-08

This round inspects additional runtime paths after the first three measured
rounds. Starting hashes and shared working-tree changes are recorded in
`initial-state.json`. Earlier optimized sources and unrelated concurrent edits
are preserved; no schema, encryption policy or durability change is planned.

## Selected experiments

| Path                                          | Caller                                                  | Hypothesis                                                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed workflow runs awaiting acknowledgement | `DeadLetterPanel` in the workflow runs view             | Use the existing workflow/status compound index to avoid decrypting failures belonging to other workflows. Retain global queries, filtering and stable sort behavior.                                                                             |
| Chat-result mention search                    | Entity mention picker and host tool lookup              | Test stopping a bounded page read once enough matches are found. A native cursor may cost more than bulk retrieval, so sparse/no-match cases are hard guardrails.                                                                                 |
| Storage breakdown and health                  | Settings overview, maintenance and mobile storage hooks | The hook currently invokes `getStats()` and `getHealth()` together, while `getHealth()` calls `getStats()` again. Derive health from the same fresh snapshot to remove a duplicate full-database walk. Standalone health calls must remain fresh. |

Every experiment records its actual storage policy, runtime caller, fixed
fixtures and acceptance rule before editing. Retain only a primary median gain
of at least 10% and greater than twice the larger MAD, with correctness and
small/adverse-workload guardrails. Timing windows within this agent team are
serialized; this shared host is not a controlled, exclusive lab machine.

No production user data or external endpoint is used. Browser IndexedDB and
React-hook measurements do not establish packaged desktop/mobile behavior,
network latency or whole-page paint time. Raw results and final checks follow
when the experiments complete.

## Workflow failure query — retained

The actual `listDeadLetters(workflowId)` function now selects the existing
`[workflowId+status]` index for a truthy workflow ID. The old filter and stable
timestamp sort remain unchanged. Undefined/empty IDs retain the global query.

| Workload                                                         | Before median / MAD | After median / MAD | Change                       |
| ---------------------------------------------------------------- | ------------------- | ------------------ | ---------------------------- |
| 1,000 runs, 200 failed across 20 workflows, 10 matching failures | 5.05 / 0.30 ms      | 0.40 / ~0 ms       | 4.65 ms saved, 92.08% faster |
| Small fixture                                                    | 0.15 ms             | 0.20 ms            | +0.05 ms, guardrail passes   |
| All failures in one workflow                                     | 4.70 ms             | 5.00 ms            | +0.30 ms, guardrail passes   |
| Global query (unchanged path)                                    | 4.80 ms             | 4.85 ms            | +0.05 ms, guardrail passes   |

Native Chromium IndexedDB, actual encrypted-content policy and Dexie defaults,
production/minified function bundle. Five full-result hashes match before/after.
Native checks cover acknowledgement `null`/`0`, missing/negative/tied timestamps,
global/empty/missing workflow IDs, five live-query emissions and locked-cipher
rejection. The measured function is AST-selected verbatim from its frozen complete
source; unrelated workflow publication and app-runtime imports are excluded. This
is a storage-query boundary, not workflow UI paint or remote execution time.
Two warmups and 12 measured samples per fixture/variant were collected in
separate before/after blocks. The primary saving exceeds its 0.60 ms noise
threshold; small/global increases are reported rather than hidden.

## Storage overview — retained

`getHealth()` now accepts an optional statistics snapshot. The hook passes the
fresh object from its one `getStats()` call on mount and refresh. A standalone
`getHealth()` still loads its own fresh statistics. The loading/error/unmount
and overlapping-refresh behavior remain covered by tests; no cache was added.

| Actual React-hook boundary | Before median / MAD | After median / MAD | Saving            |
| -------------------------- | ------------------- | ------------------ | ----------------- |
| Mount, 3,000 messages      | 169.60 / 8.50 ms    | 91.20 / 0.40 ms    | 78.40 ms / 46.23% |
| Refresh, 3,000 messages    | 161.50 / 6.20 ms    | 96.80 / 7.50 ms    | 64.70 ms / 40.06% |
| Mount, 20 messages         | 23.40 / 2.10 ms     | 18.80 / 0.80 ms    | 4.60 ms / 19.66%  |
| Mount, 100 messages        | 25.10 / 0.80 ms     | 19.90 / 0.50 ms    | 5.20 ms / 20.72%  |

Two warmups and 15 alternating pairs per variant/fixture, minified production
React (without the React Compiler transform), native Chromium IndexedDB and
WebCrypto. All 381 current schema tables exist; the large fixture contains
3,000 messages with 2 KiB text each, 300 sessions and 20 settings/backups each.
Production content policies are applied. The primary saving exceeds its
17.00 ms noise threshold, and every small/refresh guardrail passes.

Measurement ends at the React layout commit containing stats and health, not a
whole rendered settings page. Deterministic category/count/byte/health outputs
match. Native quota/usage values are recorded; generated timestamps are excluded
from parity. The fixture is unchanged by each measurement and message contents
remain encrypted. No native vector IPC, memory reduction or device latency is
claimed.

## Chat-result cursor search — rejected

| Workload                            | Before   | Candidate | Decision                                |
| ----------------------------------- | -------- | --------- | --------------------------------------- |
| Dense matches, requested 36 results | 2.50 ms  | 1.50 ms   | Local gain does not override guardrails |
| Sparse matches                      | 24.30 ms | 42.70 ms  | 75.7% slower                            |
| No matches                          | 24.60 ms | 41.50 ms  | 68.7% slower                            |
| Late matches                        | 17.20 ms | 27.00 ms  | 57.0% slower                            |

The cursor version avoided an unused page tail but regressed important search
shapes. Both source and performance-only tests are restored exactly; no production
change is retained. All 108 distinct boundary cases matched (216 baseline/candidate
API calls), including the existing page-rounded scan budget. Correctness parity
alone is insufficient to retain a slower implementation.

## Final validation and evidence

```text
Test Suites: 16 passed, 16 total
Tests:       351 passed, 351 total
```

The combined run includes workflow storage and the failure panel, storage manager
and all storage hooks, restored chat-result search and its mention caller, plus
earlier notification/session-sync/execution-journal changes. Exact commands and
outputs are in `validation/regression-tests.log`. Scoped ESLint without cache,
Prettier, diff checks, i18n parity/reference checks and i18n sorting all pass.

Full typecheck exits 2 with diagnostics outside the retained scope:

- `lib/account-sync/data/applier.test.ts(217,18)`: the partial `{ get }` object
  cannot be directly cast to `EpochKeyChain`.
- `lib/tauri/transport-companion.test.ts(3006,73)`: `sent` is not a property of
  `Promise<string>`.

No type diagnostics remain in the files changed by this round. Full lint exits 1
with `4934 problems (82 errors, 4852 warnings)`; its errors are in unrelated
`components/chat/composer.tsx` and generated
`src-tauri/resources/plugins/cognia-office/dist/index.js`.

- [Workflow experiment](history/report.md) and [storage review](history/review.md).
- [Storage-hook experiment](storage-metadata/README.md), raw samples and source hashes.
- [Rejected chat search](chat-storage/README.md) and [workflow review](chat-storage/review.md).
- [Preflight audit](preflight-audit.md): no actionable correctness or test gaps.
- `final-validation.json`: source preservation, measured-source correspondence
  and final gate exit codes.

The earlier optimized sources and rejected chat-search source/tests are preserved.
No schema, encryption policy or durability changes were made. These results
do not establish full UI paint, Tauri/Capacitor, cross-device sync, network or
production-user workload performance. Coverage and a full application/native
package build were not run. Changes remain uncommitted in the shared tree.
