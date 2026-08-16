# Managed Workspace Registry & Multi-Root Bundle — Gap Analysis (2026-08-07)

## Question

Cognia already ships Task Workspace (snapshot / patch / undo), Git worktree
management, Workspace Trust, per-`Project` multi-root, and per-agent Git
isolation. Compared with Codex Worktrees, Claude Code Worktrees, VS Code
Worktrees, and native `git-worktree`, what capabilities are genuinely missing
and where do those gaps sit in the current tree?

This document is the evidence base for **ADR-0111 — Managed Workspace
Registry & Multi-Root Bundle Unification**.

## External benchmarks

- **Codex Worktrees** ([developers.openai.com/codex/app/worktrees](https://developers.openai.com/codex/app/worktrees))
  — worktree is the first-class execution surface for the task; base ref,
  branch, IDE / terminal / apply / archive are one click; managed lifecycle
  is opaque to the user.
- **Claude Code Worktrees** ([code.claude.com/docs/en/worktrees](https://code.claude.com/docs/en/worktrees))
  — worktree survives across sessions; base ref selection and PR handoff are
  built into the CLI; each worktree has a discoverable owner.
- **VS Code Worktrees** ([code.visualstudio.com/docs/sourcecontrol/branches-worktrees](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees))
  — multi-root aggregation SCM view, per-worktree Source Control section,
  status per root.
- **git-worktree** ([git-scm.com/docs/git-worktree](https://git-scm.com/docs/git-worktree))
  — `worktree lock --reason` is the canonical "do not remove" signal; a
  lock reason is how tooling declares ownership without inventing a new
  registry.

## Current tree — what exists

### Task Workspace (`crates/cognia-task-workspace/`)

- `service.rs` (2489 lines) exposes `begin_run` / `settle_run` /
  `apply_patch_set_with_options` / `undo_patch_set` /
  `resolve_conflict_with_options` / `restore_run_snapshot` / `prune`.
- `store.rs` owns the SQLite schema: `task_workspaces`, `task_runs`,
  `task_resources`, `task_resource_events`, `task_patch_sets`, `task_blobs`
  (content-addressed, ref-counted; `prune_unreferenced_blobs`).
- `snapshot.rs::capture` / `materialize` are the canonical snapshot ↔
  filesystem primitives.
- `ledger.rs::apply` / `undo` are the hunk-level reversible engine.
- 37 `task_workspace_*` Tauri commands (`src-tauri/src/task_workspace.rs`)
  and the same allowlist in `src-tauri/src/companion_api/rpc.rs`.

**Fact**: this is a complete reversible resource engine. Nothing about
Managed Workspace Registry needs a new patch/snapshot/undo primitive.

### Git worktree seam (`crates/cognia-git/src/worktree.rs`)

- `add(main_repo, path, branch, base_ref?)` — shells out to
  `git worktree add`; auto-picks branch when caller supplies one.
- `remove(main_repo, path, force, delete_branch?)` — `git worktree remove
[--force]` then optional `worktree prune` + `branch -D`.
- `list`, `prune`, `commit` — parse `--porcelain` / delegate to
  `git worktree prune` / stage+commit convenience.
- Registered as `git_worktree_*` Tauri commands and in the companion RPC
  allowlist.
- The module's own header comment: _"Git worktree management for agent-team
  per-dispatch isolation"_ — the seam was originated by agent-team and later
  reused by the user-facing manual panel.

### Three parallel worktree owners

**All three create/tear down Git worktrees today, and none of them
coordinate:**

1. `crates/cognia-task-workspace/src/service.rs::create_execution`
   (`service.rs:1317-1358`) — creates
   `cognia/task/<taskKey>/<runKey>` per run.
2. `lib/ai/agent/team/dispatch-teammate.ts:893-955` — three paths:
   - `teamCtx.durableEnvironment.adapter.openChild` (Durable v2 —
     Task-Workspace-backed).
   - `openTaskWorkspaceRunLease` (behind `developer.taskWorkspace`).
   - Legacy `AgentWorkspaceAllocator` (`lib/ai/agent/team/workspace/allocator.ts`)
     — creates directories under
     `<parent>/.cognia-agent-worktrees/<repoName>/<runId>/<key>-<uid>`.
3. `components/source-control/worktree-panel.tsx` — user-facing manual
   worktrees via `gitWorktreeAdd` / `gitWorktreeRemove`.

**Consequence**: a `git worktree list` snapshot can contain rows from up
to three owners with no way to attribute a row to its owner or protect it
from another owner's cleanup.

### Session Execution Context (`types/execution-context.ts` +

`lib/task-workspace/session-execution-context.ts`)

- `SessionExecutionContext.baseRef` exists on the type, but
  `createSessionExecutionContext` hardcodes `"HEAD"` as a hint —
  `create_execution` (Rust) does not consume it. In practice every managed
  worktree is created from `HEAD`.
- Legacy mirror fields `worktreePath` / `branch` / `baseRef` live on the
  context alongside the newer `taskWorkspace: { taskId, workspaceKey, runId? }`.

### Scheduled tasks (`lib/scheduler/executors/index.ts`)

- The chat-scheduler executor at lines 380–482 dispatches with
  `finalOptions.cwd`.
- When `location === "managedWorktree"`, it opens a fresh
  `openTaskWorkspaceRunLease` per fire — good.
- When `location === "local"`, it sets `finalOptions.cwd =
executionContext.projectRoot` — **the user's live tree**. A background
  task can therefore land on a dirty tree with no isolation.
- The system-task scheduler (`crates/cognia-scheduling`) takes a plain
  `working_dir: Option<String>` per registered task and forwards it to
  `launchd` / Task Scheduler / systemd — zero isolation awareness.

### Workspace Trust (already gate-shaped)

- `lib/db/trusted-workspaces.ts` — Dexie table keyed by absolute path.
- `lib/workspace/trust-gate.ts::isWorkspaceRestricted(project)` — restricted
  iff any root is untrusted.
- Consumers: `build-options.ts:3561-3564` sets
  `opts.trustedWorkspaceRoots`; `hook-trust-sync.ts` — project/local hooks
  load only for trusted roots; `plugin/ide/broker-runtime.ts` gates every
  mutating IDE-plugin RPC.
- Trust identity is a **filesystem path**, not a workspace/project id.

### Multi-root

- `types/workspace/index.ts::WorkspaceRoot { id, path, label?, isPrimary? }` —
  a single `Project` mounts N directories; exactly one is primary.
- `lib/workspace/roots.ts` — `primaryRootOf`, `additionalDirsOf`,
  `allRootPaths`, `normalizeRoots`, `syncDerivedDirFields`,
  `resolveSessionProjectRoot`.
- `build-options.ts:1739` unions user-configured + roots-derived dirs
  into `opts.additionalDirectories` for sidecar handoff.
- `components/source-control/root-switcher.tsx` — dropdown that toggles
  `git-store.rootDir`; multi-root SCM is single-root-at-a-time via switcher,
  not aggregation.
- **There is no cross-Project / cross-repository "bundle" concept.** grep
  `WorkspaceBundle` / `WorkspaceRegistry` — no hits in `lib`, `types`,
  `components`, `stores`.

### Workspace Trust vs `.cognia/`

- No `.cognia/workspace.json` today. `ADR-0047` uses
  `.cognia/instructions/` and `.cognia/agents/*.md` for instructions but
  not for workspace runtime config.

### Hooks — declared but dormant

- `WorktreeCreate` / `WorktreeRemove` are:
  - Declared in `src-tauri/src/hooks/types.rs:29-30` (`HookEvent` enum).
  - Declared in `lib/claude/hooks/event-catalog.ts:66-67` with
    `{ category: "lifecycle", dormant: true }`.
  - Declared in `cli/src/hooks/types.ts:34-35` (union) and lines 68-69
    (`HOOK_EVENTS` array).
- **grep `HookEvent::WorktreeCreate` / `HookEvent::WorktreeRemove` in
  `src-tauri/src` — no usage**. No producer emits either event today.
- All three current worktree owners (task-workspace `create_execution`,
  agent-team allocator, user-facing panel) create and remove worktrees
  **without** firing hooks.

### PR abstraction (already provider-neutral)

- `types/review.ts:57-65` — `PullRequestProvider { id,
getAuthenticationState, findForBranch, push, create, publishFeedback }`.
- `lib/review/github-provider.ts` — the sole implementation.
- `lib/ai/agent/team/pr-feedback/*` still directly imports
  `@/lib/github/pr-observe/*` (Octokit-shaped). Not neutralized yet; kept
  out of scope for this workstream.

## Identified gaps

| #   | Gap                                                                                | Concrete evidence                                                                                                              |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | No single owner of worktree lifecycle                                              | Three parallel owners; none coordinate; no lock reason today                                                                   |
| 2   | Ownership is inferred, not signed                                                  | Task Workspace signals ownership via `cognia/task/**` branch-name prefix; a peer can trivially collide                         |
| 3   | `baseRef` is a hint, not an input                                                  | `create_execution` hardcodes `HEAD`; `SessionExecutionContext.baseRef` unused end-to-end                                       |
| 4   | Every dispatch creates a stale branch                                              | `-b cognia/task/**` per run leaves branches to clean up; `--detach` is never used                                              |
| 5   | Scheduled `local` runs land on the live tree                                       | `executors/index.ts` `location === "local"` sets `cwd = projectRoot` with no isolation                                         |
| 6   | No multi-root / cross-repo bundle                                                  | Only per-`Project` multi-root; no atomic apply across roots or repos                                                           |
| 7   | No project-versioned workspace config                                              | No `.cognia/workspace.json`; no place for sparse paths, cache links, include patterns to live under version control            |
| 8   | Sensitive-resource authorization is ad-hoc                                         | `is_sensitive_resource` filters preview bytes; there is no user-visible "grant this path" flow                                 |
| 9   | `WorktreeCreate` / `WorktreeRemove` hooks defined but dormant                      | No producer; three worktree owners bypass them                                                                                 |
| 10  | Retention is task-scoped, not workspace-scoped                                     | Directory reclaim and blob expiration are inside `service.prune`; no separated policy for "active dir limit" vs "snapshot age" |
| 11  | Managed items and manual `git worktree list` items are indistinguishable in the UI | `worktree-panel.tsx` can force-remove anything                                                                                 |
| 12  | Legacy allocator produces branches nobody owns                                     | `AgentWorkspaceAllocator` writes under `.cognia-agent-worktrees/**`; a crashed run leaves them behind                          |

## Design implications

The gaps split into three coherent layers:

1. **Ownership layer**: introduce a Registry with signed ownership (`ownerType`
   × `owner_ref`) and `git worktree lock --reason "cognia:<workspaceId>"` as
   the enforcement token. Startup reconcile only claims rows whose signature
   we can verify; the rest become `imported` and are never touched.
2. **Composition layer**: introduce `WorkspaceBundle` that acquires N
   `WorkspaceRootLease`s across one or more repositories, plus non-Git
   shadow roots. Multi-root Apply is precheck → apply-with-inverse →
   compensate; failure lands in `conflict`, not partial success.
3. **Configuration layer**: introduce `.cognia/workspace.json` v1 for
   version-controllable knobs (logical root IDs, roles, sparse paths, cache
   link targets, include patterns, secret **names**). Device-local state
   (root binding, keyring secret IDs, sensitive path grants, storage limits)
   stays out of the file.

## Reuse plan (do not reimplement)

- `snapshot.rs::capture` / `materialize` — the shadow-isolation and
  patch-application primitive.
- `service.apply_patch_set_with_options` / `undo_patch_set` /
  `resolve_conflict_with_options` — Bundle Apply uses these directly.
- `crates/cognia-git/src/worktree.rs` — extend `add` with `detached: bool`
  and `lock_reason: Option<String>`; extend `remove` to require a matching
  lock reason before proceeding.
- `types/review.ts::PullRequestProvider` — Bundle "publish" calls
  `.push` / `.create` per repository; workspace layer orchestrates only.
- `packages/redact/src/index.ts::hasNoLeakingPii` — sensitive-path gate for
  any copy across the boundary.
- `lib/workspace/trust-gate.ts` — setup / cache-link / hook load stays
  behind it.
- `lib/workspace/roots.ts` + `Project.roots` + `additionalDirsOf` — Bundle
  emits these structures; `build-options.ts` `additionalDirectories`
  wiring is untouched.
- Hook events `WorktreeCreate` / `WorktreeRemove` — already declared;
  Registry becomes the producer.

## Non-goals

- Rebuilding a patch/snapshot/undo engine — Task Workspace is authoritative.
- Neutralizing `pr-feedback/*` away from Octokit — separate workstream.
- Building non-GitHub `PullRequestProvider` adapters — separate workstream.
- Sync of managed workspaces across devices — retention data stays local
  (matches ADR-0086 and ADR-0108).

## Retention defaults (proposed)

| Knob                       | Default                                                                                              | User-adjustable |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | --------------- |
| Active managed directories | ≤ 15                                                                                                 | Yes             |
| Snapshot retention         | 30 days                                                                                              | Yes             |
| Blob budget                | 1 GiB                                                                                                | Yes             |
| Ineligible for auto-prune  | `active`, `pinned`, `permanent`, `locked`, `dirty`, `untracked`, `unpushed`, `unapplied`, `conflict` | No              |

## Rollback

`developer.taskWorkspace` becomes a **kill switch** for one release
cycle. When flipped off, execution paths that would have gone through the
Registry fall back to the pre-Registry behavior. Registry data is
retained. The kill switch is removed in the next release.

## Referenced files

Rust:

- `crates/cognia-task-workspace/src/{lib,service,store,snapshot,ledger,
types}.rs`
- `crates/cognia-git/src/worktree.rs`
- `src-tauri/src/{task_workspace.rs, hooks/types.rs, hooks/mod.rs,
companion_api/rpc.rs}`
- `crates/cognia-scheduling/src/scheduler/types.rs`

TypeScript:

- `types/execution-context.ts`
- `types/workspace/index.ts`
- `types/review.ts`
- `lib/task-workspace/{session-execution-context.ts, managed-workspace.ts,
handoff.ts, run-lease.ts, client.ts, projection.ts}`
- `lib/ai/agent/{agent-team-runtime.ts, team/dispatch-teammate.ts,
team/workspace/allocator.ts, team/workspace/reconciler.ts}`
- `lib/scheduler/executors/index.ts`
- `lib/claude/hooks/event-catalog.ts`
- `lib/workspace/{trust-gate.ts, roots.ts}`
- `lib/db/trusted-workspaces.ts`

UI:

- `components/chat/{chat-header.tsx, empty-state.tsx, chat-view.tsx,
session-execution-workspace.tsx, session-settings-sheet.tsx}`
- `components/source-control/{source-control-panel.tsx, worktree-panel.tsx,
root-switcher.tsx}`
- `components/settings/sections/developer-flags-card.tsx`

ADRs to amend:

- `docs/content/docs/en/adr/0086-task-scoped-resource-workspaces.md`
- `docs/content/docs/zh/adr/0086-task-scoped-resource-workspaces.md`
- `docs/content/docs/en/adr/0108-codex-inspired-desktop-workflows.md`
- `docs/content/docs/zh/adr/0108-codex-inspired-desktop-workflows.md`
