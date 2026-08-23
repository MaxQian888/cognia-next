# Workspace and Worktree Implementation Audit (2026-08-23)

## Decision

ADR-0111 remains **proposed and partially implemented**. The 2026-08-13
rollout statement overstated production coverage. This audit records what is
actually wired, what is only a primitive, and what must pass before the ADR can
be accepted.

## Benchmark baseline

The comparison target is the complete task-to-delivery loop exposed by:

- [Codex Worktrees](https://developers.openai.com/codex/app/worktrees): task
  creation, local/worktree choice, apply, IDE/terminal entry, and archive.
- [Claude Code Worktrees](https://code.claude.com/docs/en/worktrees): durable
  worktree ownership and command-line handoff.
- [VS Code branches and worktrees](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees):
  discoverable worktree and Source Control management.
- [Zed Git](https://zed.dev/docs/git): editor-native review and repository
  actions.
- [Cursor worktrees](https://prod.cursor.com/docs/configuration/worktrees):
  task-oriented isolated environments.
- [git-worktree](https://git-scm.com/docs/git-worktree): canonical porcelain
  inventory, lock reasons, pruning, and detached worktree semantics.

These products differ in scope, but the mature baseline is consistent: one
discoverable owner, an explicit execution location, a safe base, lifecycle
controls, and a clear path from isolated changes back to Local or a PR.

## Implemented and verified in this slice

| Area                          | Evidence in the tree                                                                                                      | Verification                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Canonical physical ownership  | `workspace_registry`, `workspace_bundles`, `workspace_root_leases`; managed/permanent/imported classification             | Rust persistence and transition tests                                                                   |
| Signed atomic Git acquisition | Registry reserves the ID before `git worktree add --detach --lock --reason cognia:<id>`                                   | Git lifecycle tests inspect porcelain lock reason                                                       |
| Multi-root provisioning       | Same-common-dir roots share one worktree; separate repositories receive separate worktrees; non-Git roots receive shadows | Multi-repository + shadow integration test                                                              |
| Transactional acquisition     | A failed leg removes every previously acquired Git/shadow leg and Registry row                                            | Faulted non-Git base integration test                                                                   |
| Canonical session binding     | Typed `mode`, `environmentId`, `bundleId`, `base`, and root leases; legacy mirrors remain decoder-only                    | Co-located TypeScript tests                                                                             |
| Base transport                | `workingState`, `localHead`, `remoteDefault`, `gitRef`, and typed PR request cross Rust/TypeScript boundaries             | Type and Rust base tests                                                                                |
| Repository config boundary    | `.cognia/workspace.json` schema v1 validation and safe merge into `ProjectEnvironment`                                    | Co-located parser/merge tests                                                                           |
| Lifecycle policy              | Defaults 15 / 30 days / 1 GiB, persisted device-locally; acquisition blocks at capacity                                   | Restart and capacity tests                                                                              |
| Archive/restore/delete        | Content-addressed WIP archive, physical release, signed Git restore, confirmation-gated delete                            | Shadow and Git lifecycle tests plus component tests                                                     |
| Product inventory             | `/workspace` renders Registry rows and protected lifecycle actions                                                        | Co-located component tests and i18n gates                                                               |
| Host transport                | Tauri commands and allowlist cover inventory, bundles, policy, pin, permanent, archive, restore, and delete               | Tauri `cargo check` passed before the final lifecycle extension; crate/TS transport tests pass after it |

The implementation also corrected a persistence defect discovered by the new
lifecycle tests: Registry updates now use a true SQLite UPSERT. The previous
`INSERT OR REPLACE` semantics could cascade-delete leases and archives during a
pin or state update.

## Remaining product gaps

| Priority | Gap                                                                                               | Required closure evidence                                              |
| -------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| P0       | Interactive chat does not yet expose the full Local/Worktree + base/environment picker            | Component test and real first-chat/default-memory flow                 |
| P0       | Chat header lacks the persistent environment chip and full IDE/review/publish/handoff actions     | Header state/action matrix and Tauri smoke                             |
| P0       | Scheduler, Agent Team, connectors, and every writable agent path are not yet proven Registry-only | Wiring audit plus tests showing live roots remain untouched            |
| P0       | Live `additionalDirectories` replacement by lease aliases is not complete                         | Multi-root execution test that rejects unleased writable roots         |
| P0       | Selective Apply is not yet wired as one persisted Bundle transaction                              | Fault-injected precheck/apply/compensate integration test              |
| P0       | Continue Branch in Local is absent                                                                | Occupied-branch rejection, multi-repo rollback, and non-Git apply test |
| P0       | Startup reconciliation/import discovery/adoption is planner-only                                  | Restart discovery test proving unknown worktrees are never mutated     |
| P0       | Explicit PR checkout resolution is absent from `PullRequestProvider`                              | Provider-neutral fetch-ref + immutable-SHA contract tests              |
| P1       | `/workspace` is not yet the full Overview/Environments/Source Control aggregation                 | Multi-repository state matrix and UI smoke                             |
| P1       | Manual Worktree panel does not yet consume the complete Registry inventory                        | Protected force-removal test                                           |
| P1       | Daily cleanup, snapshot expiry, blob-budget enforcement, and cleanup history are not scheduled    | Clock-controlled retention integration tests                           |
| P1       | Sensitive grants exist in Rust but lack the complete interactive/background product flow          | Audited grant UI and fail-closed background E2E                        |
| P1       | Companion/headless semantic parity for all new lifecycle commands is incomplete                   | Catalog parity gate across desktop, Companion, and headless            |
| P1       | Branch/push/draft-PR delivery-unit aggregation is absent                                          | One branch/PR per repo test without atomicity claims                   |

## Acceptance matrix

ADR-0111 may move to Accepted only when every row is green.

| Scenario                                                                  | 2026-08-23 status                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Dirty Local → Worktree → selective Apply, unrelated Local files untouched | Not run; Bundle Apply production wiring remains open       |
| Multi-repository + non-Git provisioning                                   | Passes Rust integration test                               |
| Atomic multi-root handoff                                                 | Not implemented                                            |
| Scheduled/background run leaves live roots untouched                      | Not proven across all executors                            |
| Occupied-branch rejection and successful branch handoff recovery          | Not implemented                                            |
| Archive/restore preserves WIP and releases/rematerializes directories     | Passes Rust integration tests                              |
| Capacity exhaustion blocks with actionable guidance                       | Passes Rust integration test                               |
| Permanent/imported environments resist automatic archive/delete           | Permanent passes; imported adoption/discovery remains open |
| Detached environment → branch → push → draft PR                           | Not implemented end to end                                 |
| Legacy/external worktree discovery never mutates unknown worktrees        | Planner tested; production reconcile remains open          |
| Real Tauri smoke of picker → run → review → handoff → archive             | Not run                                                    |

## Verification evidence

Checks completed during the 2026-08-23 implementation:

- `cargo test -p cognia-task-workspace --lib -- --test-threads=1`: 114 tests
  passed after lifecycle changes.
- Focused TypeScript suites for the task-workspace client, canonical session
  binding, workspace configuration, and environment inventory passed.
- `pnpm typecheck` passed.
- `pnpm i18n:build`, `pnpm i18n:build:check`, and `pnpm lint:i18n` passed.
- A Tauri `cargo check -p cognia-next` passed after bundle command wiring. A
  later repeat after lifecycle commands was interrupted while the shared
  Tauri build script was regenerating metadata; no lifecycle diagnostic had
  appeared. This is not counted as final Tauri verification.

Repository-wide coverage, docs build, all auditors, full E2E, and real Tauri
smoke remain acceptance gates rather than inferred successes.

## Recommended closure order

1. Route chat, Scheduler, Agent Team, connector, Companion, and headless write
   paths through `AcquireWorkspaceBundle`; remove live-root fallback only after
   parity tests exist.
2. Wire persisted Bundle Selective Apply and Continue Branch in Local.
3. Add startup porcelain reconciliation, imported discovery, and explicit
   Adopt.
4. Complete new-chat and header controls, then multi-repository Source Control
   aggregation and manual panel protection.
5. Add PR checkout resolution and grouped delivery units.
6. Schedule retention cleanup/history and finish grant UX.
7. Run the full acceptance matrix and only then mark ADR-0111 Accepted.
