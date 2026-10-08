# Round 4 preflight audit — 2026-10-08

**No actionable findings in the retained scope.** This is a read-only source/test audit; it does not substitute for root's execution of tests, types and repository gates.

## Scope and auditor applicability

Base: HEAD, exact retained scope:

- `lib/db/workflows.ts` and `lib/db/workflows.test.ts`
- `lib/storage/storage-manager.ts` and `lib/storage/storage-manager.test.ts`
- `hooks/storage/use-storage-breakdown.ts` and `hooks/storage/use-storage-breakdown.test.ts`

The rejected chat-result source and test have no remaining HEAD-relative diff. Other shared-tree changes are outside this audit and were not modified. Only this audit document was written.

The preflight skill's test-gap auditor applies. A dedicated test-gap subagent dispatch was attempted, but the team thread limit rejected it, so the same bounded test-gap review was performed directly here. All three changed implementation files have their co-located tests modified in this scope. Coverage was not run: project/user instructions explicitly make coverage opt-in and take precedence over the skill's generic coverage command.

Other auditor trigger sets are empty: there are no new modules/commands/settings/initializers, routes or new Node imports, TSX/i18n changes, Rust changes, schema changes or outbound model/cloud calls in this retained scope. Therefore no dedicated i18n, static-export, Rust, PII or new-module wiring fan-out was necessary. Existing runtime wiring was inspected directly below.

## Correctness and test coverage

| Changed boundary                        | Co-located verification inspected                                                                                                                                                                                                                          | Assessment                                                                                                                                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scoped failed workflow query            | New index-selection budget; same-time primary-key order; negative/missing timestamps; acknowledgement undefined/null/zero; absent/empty/missing workflow IDs. Existing tests cover status, workflow isolation, acknowledgement and replay behavior.        | No test gap for the changed query branch. The predicate and stable sort remain unchanged; equality scans retain primary-key order within the selected workflow/status subset.                                     |
| `StorageManager.getHealth(stats?)`      | New supplied-snapshot test rejects any additional getStats call; standalone call test verifies one fresh getStats call. Existing tests pin healthy/warning/critical thresholds, cleanup recommendations, quota fallback and table-read failures.           | Supplied-snapshot path invokes the unchanged pure health computation. No-argument API still reads fresh stats. No cache or persisted format introduced.                                                           |
| `useStorageBreakdown` mount and refresh | New one-read/exact-snapshot tests for mount and manual refresh; failed refresh retains previous values; unmount completion is ignored; overlapping refresh completion order is preserved. Existing tests cover initial success/error, refresh and polling. | Both active paths await stats then derive health from that same fresh object, removing only the duplicate read. Initial cancellation guard, loading state, error conversion and refresh semantics remain present. |

The tests combine functional expectations with deterministic read budgets; they do not add noisy wall-clock CI thresholds. No coverage percentage is asserted.

## Runtime wiring and evidence boundaries

`components/workflow/runs/dead-letter-panel.tsx` calls `listDeadLetters(workflowId)` inside `useLiveQuery`, so scoped reads reach the optimized branch. The existing `[workflowId+status]` schema index is present; no migration is needed. Saved native workflow evidence shows full-row result hashes matching before/after, five expected liveQuery emissions, legacy scope parity and locked-cipher rejection. The independent workflow review is also recorded in `chat-storage/review.md`.

`hooks/storage/index.ts` re-exports `useStorageBreakdown`. The settings data overview and maintenance tab consume it; `useStorageOverview` also calls it. The hook imports the existing StorageManager singleton from the storage barrel, and both mount and refresh pass their just-returned stats into the existing method. No new code is dormant. No additional runtime registration is required.

The health calculation is pure and takes only StorageStats. Reusing the object makes the displayed breakdown and health correspond to one observation; it does not weaken standalone freshness. The existing table-read fallback and quota/vector/localStorage calculation remain unchanged. Polling still invokes the same refresh callback.

Root owns final combined tests/typecheck/lint gates, with results recorded in the round summary and validation logs. This audit ran no heavy tests, builds or coverage, and makes no packaged desktop/mobile or full UI-render claim. It should be reassessed if retained source changes beyond the hashes below.

## Audited source hashes (SHA-256)

- `lib/db/workflows.ts`: `668d630a6e59ad33eb3ca9f774c66a47d963bbf823d3f9a81f6e36b895829b3f`
- `lib/db/workflows.test.ts`: `36c3111b677dfb9c4023d6645684ba28c1a9c809a68a025309107dcf07bceac1`
- `lib/storage/storage-manager.ts`: `98afb95ec27057753dc842274bc4b3e43b190392cf50c2cab26bab3afa1dab06`
- `lib/storage/storage-manager.test.ts`: `800e69dfb7d405b8bbc879fa7f340e0f534d0b2c6446fe4eb10b1d73aae1d9ae`
- `hooks/storage/use-storage-breakdown.ts`: `7477b30dc4c657dd20727b043562d13778f48cf6386f981e24c010c33654196b`
- `hooks/storage/use-storage-breakdown.test.ts`: `809c400272653322930701548e2c7eaf9fa501eee2911d0c750e8ac91db0bc8e`
