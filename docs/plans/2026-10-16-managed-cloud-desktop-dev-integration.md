# Managed desktop integration into dev

Date: 2026-10-16. User-authorized scope: integrate the reviewed ADR-0228 Phase 1–4 changes, resolve six conflicts, regenerate protocols, run targeted checks and merge into local `dev`. No push, Rust execution, provider credentials, paid smoke, image publication or production activation is authorized by this integration step.

## Integration boundary

The isolated integration worktree is `/Users/bytedance/.codex/worktrees/managed-desktop-dev-integration/cognia-next`, based on pinned `dev` `740f76e4b23ee3ddab78ab94be28ce1143706842`. The reviewed 189-path source snapshot is retained in the original handoff worktree. Shared-checkout edits are excluded from the integration commit.

All six conflicts were reproduced with three-way merging against the reviewed base `6f52d4f356d477f2786ad57c41442878417ffa35`. `gen-companion-api.test.mjs` keeps both dev's service/device Git-fetch regression and the immutable handoff tests. Five generated files were seeded from dev and then regenerated from the combined source: bridge fixtures, TypeScript identity, Rust command catalog/table and AsyncAPI. The auto-merged generator preserves dev's runtime-health contract while adding the managed desktop command sources.

The integration audit caught an additional hash defect: the runtime-health hello fixture was not in the old generator's fixed list of handshake names. A new schema/hash assertion failed at `/catalogHash`; the generator now refreshes every hello, hello_ack and hello_refused frame by type. Runtime-health Pong fields and optional HostRuntime.criticality, plus exact service/device Git-fetch distinctions, are preserved. Existing request and response schema semantics were not removed or changed.

## Validation

- Integrated application selection: 33 Jest suites, 913 tests passed.
- Desktop schema/governance selection: two tests passed, 204 unrelated tests excluded. CLI protocol, bridge client and runtime control: three suites, 35 tests passed.
- Generator/grammar/results/release selection: 94 Node tests passed after the hash repair. Independent review also validated all 19 golden frames against generated AsyncAPI.
- Generation freshness: 893 remote commands, 107 classified routes.
- i18n aggregate freshness and sorting passed; source parity/reference lint and co-located tests preserve existing baselines.
- Scoped TypeScript check still reports the same 22 diagnostics in unchanged dependency files, including unavailable dependency declarations; none is in the changed entrypoints. This is not a full TypeScript pass.
- Normal staged ESLint/Prettier, staged i18n and commitlint checks passed for the integration commit; post-hook generator freshness also passed. The isolated commit invocation disables only lint-staged's temporary stash to honor the no-stash instruction.
- Rust, coverage, full test suite, rendered UI, live Host/provider and image-build validation remain explicitly unrun. Prior static native/source and component test evidence does not establish provider qualification.

## Shared checkout preservation

The shared checkout has unrelated dirty files, including locale aggregates and ADR indexes that overlap these additions. Integration must preserve their current local deltas, not copy clean integration files over them. Before advancing dev, compare the exact old ref, index and per-path contents; prepare only the integrated paths and retain unrelated index entries. Ref advancement must compare-and-swap the expected old dev revision. Record post-integration preservation evidence separately. No stash, reset, branch switch, or staging of foreign files is permitted.

A separate uncommitted browser-companion ADR in the shared tree also currently uses number 0228. This integration retains the user's accepted managed desktop ADR and leaves the other session's file and metadata untouched; numbering coordination for that foreign draft is outside this change.

## Provider credentials and later qualification

E2B's current [API key documentation](https://docs.e2b.dev/api-key) directs users to the [E2B Console](https://console.e2b.dev/) to obtain an API key (checked 2026-10-16). Use the intended account/team. The key authenticates E2B SDK/CLI operations; obtaining it does not authorize this agent to spend.

For Cognia, store it on the selected Host using `managed-desktop-operator store-key` and private non-terminal stdin, matching that Host's data directory, OS user and build profile. Do not put it into browser state, configuration JSON, Git, command arguments or chat. The existing Phase 1 report documents the Host secret namespace and setup. The provider/account configuration, immutable image/release, plan/price and budget must be confirmed before a separately authorized smoke. All creation/GUI/handoff qualification gates remain dormant until measured smoke succeeds; no key or paid operation was used in this integration.
