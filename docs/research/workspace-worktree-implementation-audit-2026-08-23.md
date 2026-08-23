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

| Area                          | Evidence in the tree                                                                                                         | Verification                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Canonical physical ownership  | `workspace_registry`, `workspace_bundles`, `workspace_root_leases`; managed/permanent/imported classification                | Rust persistence and transition tests                                     |
| Signed atomic Git acquisition | Registry reserves the ID before `git worktree add --detach --lock --reason cognia:<id>`                                      | Git lifecycle tests inspect porcelain lock reason                         |
| Multi-root provisioning       | Same-common-dir roots share one worktree; separate repositories receive separate worktrees; non-Git roots receive shadows    | Multi-repository + shadow integration test                                |
| Transactional acquisition     | A failed leg removes every previously acquired Git/shadow leg and Registry row                                               | Faulted non-Git base integration test                                     |
| Canonical session binding     | Typed `mode`, `environmentId`, `bundleId`, `base`, and root leases; legacy mirrors remain decoder-only                       | Co-located TypeScript tests                                               |
| Base transport                | `workingState`, `localHead`, `remoteDefault`, `gitRef`, and typed PR request cross Rust/TypeScript boundaries                | Type and Rust base tests                                                  |
| Repository config boundary    | `.cognia/workspace.json` schema v1 validation and safe merge into `ProjectEnvironment`                                       | Co-located parser/merge tests                                             |
| Lifecycle policy              | Defaults 15 / 30 days / 1 GiB, persisted device-locally; acquisition blocks at capacity                                      | Restart and capacity tests                                                |
| Archive/restore/delete        | Content-addressed WIP archive, physical release, signed Git restore, confirmation-gated delete                               | Shadow and Git lifecycle tests plus component tests                       |
| Product inventory             | `/workspace` renders Registry rows and protected lifecycle actions                                                           | Co-located component tests and i18n gates                                 |
| Interactive chat entry        | New chat exposes Local/Worktree, remembers the per-Project choice, and renders a persistent environment chip                 | Focused picker/header component and session-binding tests                 |
| Registry-backed chat          | Worktree chat acquires a persisted bundle and replaces live Project roots and `additionalDirectories` with lease aliases     | Focused route/session bundle tests                                        |
| Pull request bases            | Provider-neutral PR checkout resolution returns a fetch ref and immutable SHA; Rust fetches and verifies the resolved head   | GitHub provider, Rust base, and session bundle tests                      |
| Import and adoption           | Startup reconcile registers external worktrees as Imported without mutation; explicit Adopt establishes signed ownership     | Restart, foreign-lock, interrupted-lock retry, and capacity tests         |
| Scheduled canonical binding   | Scheduled chat borrows the persisted bundle and replaces live additional directories with Registry aliases                   | Full scheduler executor suite (74 tests)                                  |
| Unified management views      | `/workspace` exposes Overview, Environments, and the existing multi-root Source Control panel                                | Focused workspace overview suite (9 tests)                                |
| Protected manual inventory    | Manual inventory joins Git rows with Registry ownership and disables removal for owned/imported paths                        | Focused Worktree panel suite (20 tests)                                   |
| Host removal guard            | Tauri and Companion generic removal reconcile the repository, import unknown worktrees, and reject every Registry-owned path | Two Registry guard tests plus one real Tauri command test                 |
| Host transport                | Tauri and Companion runtime contracts cover inventory, bundles, lifecycle, policy, pin, permanent, and adoption              | Crate/TypeScript transport tests; generated headless catalogs remain open |

The implementation also corrected a persistence defect discovered by the new
lifecycle tests: Registry updates now use a true SQLite UPSERT. The previous
`INSERT OR REPLACE` semantics could cascade-delete leases and archives during a
pin or state update.

## Remaining product gaps

| Priority | Gap                                                                                                                  | Required closure evidence                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| P0       | Picker/header actions are implemented, but the complete review/publish/handoff flow lacks a real Tauri smoke         | Tauri picker → run → review → handoff → archive smoke                   |
| P0       | Agent Team, connectors, non-chat scheduler executors, and every writable agent path are not yet proven Registry-only | Wiring audit plus tests showing live roots remain untouched             |
| P0       | Selective Apply is not yet wired as one persisted Bundle transaction                                                 | Fault-injected precheck/apply/compensate integration test               |
| P0       | Continue Branch in Local is absent                                                                                   | Occupied-branch rejection, multi-repo rollback, and non-Git apply test  |
| P1       | Daily cleanup, snapshot expiry, blob-budget enforcement, and cleanup history are not scheduled                       | Clock-controlled retention integration tests                            |
| P1       | Sensitive grants exist in Rust but lack the complete interactive/background product flow                             | Audited grant UI and fail-closed background E2E                         |
| P1       | Generated CLI/headless/OpenAPI catalogs lag the canonical Companion contract                                         | Regenerate after unrelated undeclared app routes stop blocking the gate |
| P1       | Branch/push/draft-PR delivery-unit aggregation is absent                                                             | One branch/PR per repo test without atomicity claims                    |

## Acceptance matrix

ADR-0111 may move to Accepted only when every row is green.

| Scenario                                                                  | 2026-08-23 status                                     |
| ------------------------------------------------------------------------- | ----------------------------------------------------- |
| Dirty Local → Worktree → selective Apply, unrelated Local files untouched | Not run; Bundle Apply production wiring remains open  |
| Multi-repository + non-Git provisioning                                   | Passes Rust integration test                          |
| Atomic multi-root handoff                                                 | Not implemented                                       |
| Scheduled/background run leaves live roots untouched                      | Scheduled canonical chat passes; other executors open |
| Occupied-branch rejection and successful branch handoff recovery          | Not implemented                                       |
| Archive/restore preserves WIP and releases/rematerializes directories     | Passes Rust integration tests                         |
| Capacity exhaustion blocks with actionable guidance                       | Passes Rust integration test                          |
| Permanent/imported environments resist automatic archive/delete           | Passes focused lifecycle and explicit-adoption tests  |
| Detached environment → branch → push → draft PR                           | Not implemented end to end                            |
| Legacy/external worktree discovery never mutates unknown worktrees        | Passes restart reconcile and explicit-adoption tests  |
| Real Tauri smoke of picker → run → review → handoff → archive             | Not run                                               |

## Verification evidence

Checks completed during the 2026-08-23 implementation:

- `cargo test -p cognia-task-workspace --lib -- --test-threads=1`: 121 tests
  passed before the final adoption robustness additions. The three directly
  affected Registry/reconcile/capacity tests then passed individually.
- Focused TypeScript suites for the task-workspace client, canonical session
  binding, workspace configuration, environment inventory, chat picker/header,
  PR resolution, and Companion transport passed. The final adoption slice ran
  20 focused frontend tests.
- The scheduler executor suite passed 74 tests; Workspace management tabs
  passed 9 tests; the protected Worktree inventory passed 20 tests.
- The host worktree removal guard passed two focused
  `cognia-task-workspace` tests and one direct `cognia-next` Tauri command
  test. `cargo check -p cognia-next --lib` passed. Focused Clippy passed after
  allowing six pre-existing lint categories elsewhere in the crate; the
  unfiltered run still reports nine unrelated existing findings.
- `pnpm typecheck` passed.
- `pnpm i18n:build`, `pnpm i18n:build:check`, and `pnpm lint:i18n` passed.
- A Tauri `cargo check -p cognia-next` passed after bundle command wiring. The
  final adoption slice intentionally used file-scoped lint/format and focused
  tests; it did not claim a later full Tauri verification.
- The canonical Companion command/request/response descriptors include Adopt.
  Generated CLI/headless/OpenAPI artifacts are not counted as current because
  their generator is blocked by unrelated undeclared app routes in the shared
  worktree.

Repository-wide coverage, docs build, all auditors, full E2E, and real Tauri
smoke remain acceptance gates rather than inferred successes.

## Recommended closure order

1. Route Agent Team, connectors, non-chat scheduler executors, and every
   remaining writable path through `AcquireWorkspaceBundle`; remove live-root
   fallback only after parity tests exist.
2. Wire persisted Bundle Selective Apply and Continue Branch in Local.
3. Add grouped branch/push/draft-PR delivery units.
4. Schedule retention cleanup/history and finish grant UX.
5. Regenerate and verify the CLI/headless/OpenAPI catalogs after the unrelated
   route declarations are repaired.
6. Run the full acceptance matrix and only then mark ADR-0111 Accepted.
