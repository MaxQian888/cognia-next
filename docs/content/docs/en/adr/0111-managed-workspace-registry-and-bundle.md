---
title: "ADR-0111: Managed Workspace Registry and Multi-Root Bundle"
description: Unify worktree ownership, base-ref selection, cross-root atomic apply, sensitive-resource authorization, and lifecycle hooks behind one Registry that reuses the existing Task Workspace patch engine.
---

# ADR-0111: Managed Workspace Registry and Multi-Root Bundle

## Status

Proposed, partially implemented (2026-08-23). Amends ADR-0086 and ADR-0108.

ADR-0111 is **not accepted**. Acceptance requires the end-to-end matrix in
Verification to pass, including background isolation, both handoff modes,
archive/restore, imported discovery, and real Tauri smoke coverage.

## Rollout correction (2026-08-23)

The 2026-08-13 statement that Registry storage, bundles, scheduler isolation,
and AgentTeam leases were implemented was inaccurate. The current tree now has
durable Registry and Bundle rows, signed atomic Git creation, transactional
multi-root acquisition (including non-Git shadows), canonical session bindings,
repository configuration validation, lifecycle policy persistence/capacity
enforcement, archive/restore/delete, protected permanent/imported
classification, startup import plus explicit adoption, provider-neutral PR base
resolution, Tauri/Companion commands, canonical scheduled-chat bundle leases,
new-chat/header controls, and unified Overview/Environments/Source Control
views. The manual Worktree panel now consumes Registry ownership and refuses
removal of owned or imported rows. The Tauri and Companion removal command is
also Registry-guarded: it reconciles the target repository, imports previously
unknown external worktrees, and rejects every Registry-owned path before Git
can mutate it.

The rollout is still incomplete: all writable agent entry points are not yet
proven to acquire Registry Bundles; Agent Team still constructs its legacy
allocator, persisted multi-root Selective Apply and Continue Branch handoff are
open, generated headless catalogs lag the canonical protocol, and cleanup
scheduling/history, grant UX, grouped delivery, and the acceptance E2E matrix
remain open. No legacy allocator or live-tree fallback may be described as
migrated until those consumers and tests are closed. See the dated
implementation audit in
`docs/research/workspace-worktree-implementation-audit-2026-08-23.md`.

## Context

Cognia already owns Task Workspace snapshots and patches, the Git worktree seam, Workspace Trust, per-`Project` multi-root, and per-agent Git isolation. Compared with Codex Worktrees, Claude Code Worktrees, VS Code Worktrees, and native `git-worktree`, the missing capabilities are not new patch primitives — they are unified ownership, versioned execution context, cross-root composition, sensitive-resource authorization, and product-level discoverability. Evidence is in `docs/research/managed-workspace-registry-gap-analysis-2026-08-07.md`.

Three separate owners create and remove Git worktrees today (`crates/cognia-task-workspace::create_execution`, Agent Team dispatch's three parallel paths, and the user-facing `worktree-panel.tsx`) with no coordination. `SessionExecutionContext.baseRef` is a hint that the backend never consumes. Scheduled `location === "local"` runs land on the user's live tree. Multi-root exists only inside a single `Project`. `.cognia/workspace.json` does not exist. `WorktreeCreate` / `WorktreeRemove` hook events are declared but dormant.

## Decision

1. **Registry lives inside `cognia-task-workspace`.** Do not create a new crate. Add `registry.rs` (state machine, ownership, reconcile, retention), `bundle.rs` (Bundle / RootLease, atomic apply), and `sensitive.rs` (classification and audit) alongside the existing `service.rs` / `store.rs`. `store.rs` gains two tables via one up-migration: `workspace_registry` (owner_type, owner_ref, state, source_root, git_common_dir, base_kind, base_ref, head, branch, isolation_kind, execution_root, snapshot_task_id, size_bytes, last_used_at, locked_by, pin) and `workspace_root_leases` (bundle_id, workspace_id, logical_root_id, role, alias_path).

2. **State machine.** Every managed workspace transitions across `provisioning → active → (archived | conflict) → (restorable | removing) → removed`. Any transition outside the Registry's controlled paths is fail-closed. `active`, `pinned`, `permanent`, `locked`, `dirty`, `untracked`, `unpushed`, `unapplied`, and `conflict` are ineligible for automatic prune. Directory reclaim and snapshot expiration are separate periodic jobs and each writes its own audit trail.

3. **Signed ownership.** `ownerType ∈ {user, imported, session, team, scheduled}` and `owner_ref` are the identity; branch-name prefixes such as `cognia/task/**` are no longer treated as ownership. Startup reconcile claims only rows whose signature verifies; unowned rows on disk are marked `imported` and are never auto-pruned. Managed worktrees carry `git worktree lock --reason "cognia:<workspaceId>"`; only the Registry's controlled remove path unlocks. `components/source-control/worktree-panel.tsx` refuses to force-remove any managed row. The host command repeats the ownership check after reconciling the repository, so direct Tauri, Companion, and headless callers cannot bypass the renderer.

4. **Detached HEAD by default.** `service::create_execution` invokes `git worktree add --detach <path> <base>`. A branch is created only when the user explicitly executes `Create branch here`, in which case the Registry chooses between `-b <name>` and `git branch --track` based on the base kind. Stale `cognia/task/**` branches per run are eliminated.

5. **Real `WorkspaceBaseSpec` input.** `SessionExecutionContext.baseRef` becomes a typed `WorkspaceBaseSpec = "workingState" | "localHead" | "remoteDefault" | { gitRef } | { pullRequest }`, wired end-to-end through the Registry into `create_execution`. Interactive worktrees default to `workingState` (dirty local content is carried into the isolated root); background and scheduled Git tasks default to `remoteDefault` with `origin/HEAD` refreshed at fire time. Missing remote, offline, or setup failure fails closed with an actionable error; the executor never falls back to the live tree. The legacy `worktreePath` / `branch` / `baseRef` mirror fields are retained for one release cycle for read-only fallback under the kill switch.

6. **Multi-root Bundle with atomic apply.** `WorkspaceBundle` acquires one `WorkspaceRootLease` per logical root. Roots that share a Git common dir reuse one physical worktree; roots in different repositories each get their own worktree; non-Git roots go to `IsolationKind::Shadow` via `snapshot::capture` + `materialize`. Apply proceeds precheck → apply-with-inverse (reusing `service::apply_patch_set_with_options`) → compensate. Compensation success returns the bundle to the pre-apply state; compensation failure lands the bundle in `state = conflict` with the exact partial-apply view preserved and the existing three-way `ConflictResolution` (`RetryMerge` / `ApplyTask` / `KeepCurrent`) as recovery entries. Cross-repository publish is one branch/PR per repository, grouped into one delivery unit in the UI; no cross-repository network atomicity is claimed.

7. **`.cognia/workspace.json` v1 as version-controllable config.** The file holds only what can safely enter version control: logical root IDs, relative path hints, roles, default execution and base policy, setup and actions, non-sensitive env variables, sparse paths, cache-link targets (relative), include patterns, lifecycle hooks that route through `WorktreeCreate` / `WorktreeRemove`, and required secret **names**. Actual root bindings, keyring secret IDs, sensitive-path grants, worktree storage roots, and per-device capacity limits stay in a device-local table. `version: 1` is the schema seed.

8. **Sensitive resources are grant-based.** Include patterns accept relative paths only and reject `..`, absolute paths, and escaping symlinks. Sensitive paths default to deny. Interactive tasks may grant a path (persisted, audited). Background tasks may only use paths previously granted; missing grants fail closed with no silent degradation. Sensitive copies pass through `packages/redact/src/index.ts::hasNoLeakingPii` before the boundary.

9. **`WorktreeCreate` / `WorktreeRemove` hooks activated.** _(Wording revised by ADR-0132 slice ④, which shipped the producers.)_ There are two producers, not one: the Registry state machine emits through an injected `WorktreeLifecycleSink` (`crates/cognia-task-workspace/src/lifecycle.rs`, installed by `src-tauri/src/task_workspace.rs`) once a `GitWorktree` execution becomes `active` and when it is discarded or pruned; and the renderer's `lib/git/commands.ts` fires the same events after `git_worktree_add` / `git_worktree_remove` succeed, which covers the Agent Team allocator and the source-control worktree panel — the two owners the Registry does not sit in front of. Materialized shadows of non-Git roots do not emit. Both events are observational (they never block the git operation) and run through the ordinary session-scoped hook runner; they do **not** add a Workspace Trust check of their own — the trust gate is applied where the worktree is opened, not where the hook fires.

10. **Retention.** Default active-managed directory cap: 15. Snapshot retention: 30 days. Blob budget: 1 GiB. All three are user-adjustable in settings. Directory reclaim and snapshot expiration are separate, both consult the ineligibility list in decision (2), and each records an audit row.

11. **Interactive product entry.** Chat creation exposes an explicit `Local | Worktree` picker with base and environment selectors; Worktree is the recommended default for interactive tasks. Chat Header carries a persistent path · branch · base chip and a popover with Open in IDE, Open in Terminal, Handoff to Local, Handoff to Worktree, Review, Apply, Create branch here, Push, Create draft PR, Archive, and Restore. A unified Managed Workspaces page lists every Registry row with owner, state, base, branch, path, WIP, ahead/behind, size, lock, last-used, and PR status; protected-delete refuses any bypass.

12. **Executor migration.** `lib/scheduler/executors/index.ts` forces every scheduled fire through a Registry Bundle; the `location === "local"` branch that ran on the live tree is deleted. `lib/ai/agent/agent-team-runtime.ts` and `lib/ai/agent/team/dispatch-teammate.ts` acquire one Registry Bundle per dispatch; `lib/ai/agent/team/workspace/{allocator.ts, reconciler.ts}` are removed in this change, and the `WorktreeGitOps` seam is deleted if no other consumer remains.

13. **Publish stays behind `PullRequestProvider`.** The Registry's Push / Create draft PR actions call `types/review.ts::PullRequestProvider` `.push` / `.create` per repository. `lib/ai/agent/team/pr-feedback/*` remains directly Octokit-shaped and is not touched by this workstream.

14. **Kill switch.** `developer.taskWorkspace` becomes a rollback kill switch for one release cycle. When off, the Registry is bypassed and legacy paths (that read from the retained mirror fields in decision (5)) run. Registry data is retained across the toggle. The kill switch and the mirror fields are removed in the following release.

## Consequences

- One Registry owns every managed worktree; peers cannot silently delete each other's work.
- Every scheduled and background run is isolated; a dirty user tree is unreachable from a scheduled fire.
- Base-ref selection reaches the backend for the first time; per-dispatch stale branches disappear.
- Multi-root apply is atomic within one Bundle and produces an inspectable `conflict` state on failure, not partial success.
- Sensitive paths cannot leak into background execution without an interactive grant of record.
- Dormant `WorktreeCreate` / `WorktreeRemove` hooks become the extension seam users expect.
- Product entry (new-chat picker, Header chip, unified page) matches the discoverability level of Codex and Claude Code without cloning either.
- Retention policy is legible: directory pressure and snapshot age are separate levers.
- `pr-feedback` and non-GitHub `PullRequestProvider` adapters remain independent, deferred workstreams.

## Verification

Rust unit and integration tests (`cargo test`): state machine transitions and illegal-transition rejection; startup reconcile only claims signed rows; lock-reason enforcement; detached HEAD default; `WorkspaceBaseSpec` reaches `create_execution`; Bundle apply fault-injection covers precheck rejection, mid-apply failure with compensation success, and compensation failure landing in `conflict`; process-restart recovery of `conflict`; retention separation (directory reclaim vs snapshot expiration) with the ineligibility list respected; non-Git shadow rejects `..`, absolute paths, and escaping symlinks; sensitive-path grant persistence and background fail-closed.

Frontend co-located tests (`pnpm test:coverage:changed -- --strict`, ≥ 90 % on touched files): new-chat picker; Header chip and popover for every action and every error branch; unified Managed Workspaces page state matrix and protected-delete refusals; multi-root Source Control aggregation; managed items refuse force in `worktree-panel.tsx`; sensitive-authorization dialog. Every new user-visible string exists in both `i18n/messages/en.json` and `zh-CN.json` and `pnpm lint:i18n` passes.

End-to-end (`pnpm test:e2e`): dirty local → interactive Worktree → selective apply back to local; scheduled task from clean remote asserts the live tree is untouched; multi-repository Bundle atomic apply and compensation-success; Bundle compensation-failure conflict recovery; Agent Team and normal Session concurrent runs cannot delete each other's worktrees (lock enforced); archive releases the directory immediately, restore within 30 days succeeds, exceeding the blob budget prunes safely; detached workspace `Create branch here` → push → `PullRequestProvider.create` draft PR.

Preflight and gates: `test-gap-auditor`, `i18n-reviewer`, `static-export-auditor`, `tauri-rust-reviewer`, `pii-gate-auditor`, and `wiring-auditor` per diff triggers; `rtk tsc && rtk pnpm lint && rtk pnpm lint:i18n && pnpm i18n:sort:check`; `pnpm test:coverage` for the repo-wide layered floors; `rtk cargo test --manifest-path src-tauri/Cargo.toml` plus `cargo fmt --check` and ratcheted clippy; `rtk pnpm docs:build`; `pnpm audit:colocated-tests`; a real `pnpm tauri dev` smoke covering new-chat Worktree → apply → restore → archive.

## References

- Research: `docs/research/managed-workspace-registry-gap-analysis-2026-08-07.md`
- Codex Worktrees: [developers.openai.com/codex/app/worktrees](https://developers.openai.com/codex/app/worktrees)
- Claude Code Worktrees: [code.claude.com/docs/en/worktrees](https://code.claude.com/docs/en/worktrees)
- VS Code Worktrees: [code.visualstudio.com/docs/sourcecontrol/branches-worktrees](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees)
- git-worktree: [git-scm.com/docs/git-worktree](https://git-scm.com/docs/git-worktree)
- Amends: `docs/content/docs/en/adr/0086-task-scoped-resource-workspaces.md`, `docs/content/docs/en/adr/0108-codex-inspired-desktop-workflows.md`
