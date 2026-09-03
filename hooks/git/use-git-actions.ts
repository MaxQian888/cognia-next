/**
 * useGitActions — thin mutation wrappers that keep components dumb.
 *
 * Each action sets its `ops[op]` flag (drives spinners + disabled state),
 * calls the backend, refreshes on success, and on failure records the error in
 * the store and surfaces a localized toast. The `refresh` callback comes from
 * `useGitRepo` so a single source re-fetches status after every change.
 */

"use client"

import { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  gitCheckoutBranch,
  gitCherryPick,
  gitCommit,
  gitCreateBranch,
  gitCreateTag,
  gitDeleteBranch,
  gitDeleteTag,
  gitPushTag,
  gitDiscard,
  gitDiscardAll,
  gitFetch,
  gitIgnoreAdd,
  gitMerge,
  gitMergeAbort,
  gitPull,
  gitPush,
  gitRebase,
  gitInteractiveRebase,
  gitRemoteAdd,
  gitRemoteRemove,
  gitRenameBranch,
  gitReset,
  gitResolveConflict,
  gitRestore,
  gitRevert,
  gitSequencerAbort,
  gitSequencerContinue,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashPop,
  gitStashPush,
  gitSync,
  gitUnstage,
  runGitUserAction,
  resolveGitOperationAvailability,
} from "@/lib/git/commands"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import {
  asGitError,
  type ConflictSide,
  type GitErrorKind,
  type GitErrorPayload,
  type GitResetMode,
  type RebaseTodoEntry,
} from "@/types/git"
import { useGitStore, type GitOp } from "@/stores/git/git-store"

const OP_ERROR_KEY: Partial<Record<GitOp, string>> = {
  commit: "commitFailed",
  push: "pushFailed",
  pull: "pullFailed",
  checkout: "checkoutFailed",
}

export interface UseGitActionsResult {
  can: (command: string) => boolean
  stage: (paths: string[], hunkPatch?: string) => Promise<GitActionResult>
  unstage: (paths: string[], hunkPatch?: string) => Promise<GitActionResult>
  discard: (paths: string[], hunkPatch?: string) => Promise<GitActionResult>
  discardAll: (includeUntracked: boolean) => Promise<GitActionResult>
  commit: (
    message: string,
    options?: { amend?: boolean; signoff?: boolean }
  ) => Promise<GitActionResult>
  checkout: (name: string) => Promise<GitActionResult>
  createBranch: (name: string, checkout: boolean, from?: string) => Promise<GitActionResult>
  deleteBranch: (name: string, force: boolean) => Promise<GitActionResult>
  renameBranch: (newName: string, old?: string) => Promise<GitActionResult>
  fetch: (options?: { prune?: boolean }) => Promise<GitActionResult>
  pull: (options?: { rebase?: boolean }) => Promise<GitActionResult>
  push: (options?: { setUpstream?: boolean; forceWithLease?: boolean }) => Promise<GitActionResult>
  sync: () => Promise<GitActionResult>
  stashPush: (options?: {
    message?: string
    includeUntracked?: boolean
    keepIndex?: boolean
  }) => Promise<GitActionResult>
  stashPop: (index: number) => Promise<GitActionResult>
  stashApply: (index: number) => Promise<GitActionResult>
  stashDrop: (index: number) => Promise<GitActionResult>
  resolveConflict: (
    path: string,
    resolution: { mergedContent?: string; side?: ConflictSide }
  ) => Promise<GitActionResult>
  /** `git merge <branch>` into the current branch. */
  merge: (branch: string) => Promise<GitActionResult>
  /** Append a pattern to the repo-root `.gitignore`. */
  ignoreAdd: (pattern: string) => Promise<GitActionResult>
  mergeAbort: () => Promise<GitActionResult>
  remoteAdd: (name: string, url: string) => Promise<GitActionResult>
  remoteRemove: (name: string) => Promise<GitActionResult>
  createTag: (name: string, message?: string, target?: string) => Promise<GitActionResult>
  deleteTag: (name: string) => Promise<GitActionResult>
  pushTag: (name: string, remote?: string) => Promise<GitActionResult>
  reset: (mode: GitResetMode, target: string) => Promise<GitActionResult>
  restore: (paths: string[], staged?: boolean, source?: string) => Promise<GitActionResult>
  rebase: (onto: string) => Promise<GitActionResult>
  cherryPick: (sha: string) => Promise<GitActionResult>
  revert: (sha: string) => Promise<GitActionResult>
  sequencerContinue: () => Promise<GitActionResult>
  sequencerAbort: () => Promise<GitActionResult>
  interactiveRebase: (base: string, entries: RebaseTodoEntry[]) => Promise<GitActionResult>
}

/**
 * Failures the caller turns into a next step, so this hook must not also toast
 * them. A toast beside an open dialog says the same thing twice and reads as
 * two separate failures.
 *
 *  - `identityRequired` opens the identity dialog (`commit-box`).
 *  - `branchCheckedOutElsewhere` becomes "open that worktree": the branch is
 *    fine, it just lives elsewhere.
 *  - `branchNotFullyMerged` becomes the force-delete confirmation.
 *
 * NOTE: `kind` survives only on the desktop. `companion_api/rpc/source_control`
 * flattens every git failure with `RpcError::internal(e.to_string())`, so
 * `asGitError` answers null over a paired transport and these paths fall back
 * to the toast. Tracked separately from this hook.
 */
const CALLER_HANDLED_ERRORS: ReadonlySet<GitErrorKind> = new Set<GitErrorKind>([
  "identityRequired",
  "branchCheckedOutElsewhere",
  "branchNotFullyMerged",
])

export type GitActionResult = GitErrorPayload | null

export function useGitActions(refresh: () => Promise<void>): UseGitActionsResult {
  const t = useTranslations("sourceControl")
  const rootDir = useGitStore((s) => s.rootDir)
  const setOp = useGitStore((s) => s.setOp)
  const setError = useGitStore((s) => s.setError)
  const clearError = useGitStore((s) => s.clearError)
  const currentBranch = useGitStore((s) => s.status?.branch ?? null)
  const runtimeSnapshot = useRuntimeSnapshot()
  const can = useCallback(
    (command: string) =>
      resolveGitOperationAvailability(runtimeSnapshot, command).state === "available",
    [runtimeSnapshot]
  )

  const run = useCallback(
    async (
      op: GitOp,
      command: string,
      fn: (rp: string) => Promise<unknown>
    ): Promise<GitActionResult> => {
      if (!rootDir) {
        // A click must never be silent: surface why nothing will happen.
        toast.error(t("errors.noRepo"))
        return { kind: "notARepo", detail: t("errors.noRepo") }
      }
      setOp(op, true)
      clearError()
      try {
        try {
          await runGitUserAction(command, () => fn(rootDir))
        } catch (err) {
          const payload = asGitError(err) ?? {
            kind: "commandFailed" as const,
            detail: String(err),
          }
          const message = payload.detail ?? payload.kind
          setError(op, message)
          if (!CALLER_HANDLED_ERRORS.has(payload.kind)) {
            const key = OP_ERROR_KEY[op] ?? "generic"
            toast.error(t(`errors.${key}`, { message }))
          }
          return payload
        }

        try {
          await refresh()
        } catch {
          // The mutation itself succeeded. Treating a follow-up read failure as
          // a failed mutation invites destructive retries (for example, a
          // duplicate commit). The loader owns the inline retry state.
          toast.error(t("errors.refreshFailed"))
        }
        return null
      } finally {
        setOp(op, false)
      }
    },
    [rootDir, refresh, setOp, setError, clearError, t]
  )
  return useMemo<UseGitActionsResult>(
    () => ({
      can,
      stage: (paths, hunkPatch) =>
        run("stage", "git_stage", (rp) => gitStage(rp, paths, hunkPatch)),
      unstage: (paths, hunkPatch) =>
        run("unstage", "git_unstage", (rp) => gitUnstage(rp, paths, hunkPatch)),
      discard: (paths, hunkPatch) =>
        run("discard", "git_discard", (rp) => gitDiscard(rp, paths, hunkPatch)),
      discardAll: (includeUntracked) =>
        run("discard", "git_discard_all", (rp) => gitDiscardAll(rp, includeUntracked)),
      commit: (message, options) =>
        run("commit", "git_commit", (rp) =>
          gitCommit(rp, message, options?.amend ?? false, options?.signoff ?? false)
        ),
      checkout: (name) =>
        run("checkout", "git_checkout_branch", (rp) => gitCheckoutBranch(rp, name)),
      createBranch: (name, checkout, from) =>
        run("branch", "git_create_branch", (rp) => gitCreateBranch(rp, name, checkout, from)),
      deleteBranch: (name, force) =>
        run("branch", "git_delete_branch", (rp) => gitDeleteBranch(rp, name, force)),
      renameBranch: (newName, old) =>
        run("branch", "git_rename_branch", (rp) => gitRenameBranch(rp, newName, old)),
      fetch: (options) =>
        run("fetch", "git_fetch", (rp) => gitFetch(rp, undefined, options?.prune ?? false)),
      pull: (options) =>
        run("pull", "git_pull", (rp) => gitPull(rp, { rebase: options?.rebase ?? false })),
      push: (options) =>
        run("push", "git_push", (rp) =>
          gitPush(rp, {
            setUpstream: options?.setUpstream,
            forceWithLease: options?.forceWithLease,
            branch: options?.setUpstream ? (currentBranch ?? undefined) : undefined,
            // No remote: the backend resolves the publish target from the
            // repo's configured remotes instead of assuming "origin".
          })
        ),
      sync: () => run("sync", "git_sync", (rp) => gitSync(rp)),
      stashPush: (options) => run("stash", "git_stash_push", (rp) => gitStashPush(rp, options)),
      stashPop: (index) => run("stash", "git_stash_pop", (rp) => gitStashPop(rp, index)),
      stashApply: (index) => run("stash", "git_stash_apply", (rp) => gitStashApply(rp, index)),
      stashDrop: (index) => run("stash", "git_stash_drop", (rp) => gitStashDrop(rp, index)),
      resolveConflict: (path, resolution) =>
        run("resolve", "git_resolve_conflict", (rp) => gitResolveConflict(rp, path, resolution)),
      merge: (branch) => run("sequence", "git_merge", (rp) => gitMerge(rp, branch)),
      ignoreAdd: (pattern) => run("ignore", "git_ignore_add", (rp) => gitIgnoreAdd(rp, pattern)),
      mergeAbort: () => run("resolve", "git_merge_abort", (rp) => gitMergeAbort(rp)),
      remoteAdd: (name, url) =>
        run("remote", "git_remote_add", (rp) => gitRemoteAdd(rp, name, url)),
      remoteRemove: (name) => run("remote", "git_remote_remove", (rp) => gitRemoteRemove(rp, name)),
      createTag: (name, message, target) =>
        run("tag", "git_create_tag", (rp) => gitCreateTag(rp, name, message, target)),
      deleteTag: (name) => run("tag", "git_delete_tag", (rp) => gitDeleteTag(rp, name)),
      pushTag: (name, remote) => run("tag", "git_push_tag", (rp) => gitPushTag(rp, name, remote)),
      reset: (mode, target) => run("reset", "git_reset", (rp) => gitReset(rp, mode, target)),
      restore: (paths, staged, source) =>
        run("restore", "git_restore", (rp) => gitRestore(rp, paths, staged, source)),
      rebase: (onto) => run("sequence", "git_rebase", (rp) => gitRebase(rp, onto)),
      cherryPick: (sha) => run("sequence", "git_cherry_pick", (rp) => gitCherryPick(rp, sha)),
      revert: (sha) => run("sequence", "git_revert", (rp) => gitRevert(rp, sha)),
      sequencerContinue: () =>
        run("sequence", "git_sequencer_continue", (rp) => gitSequencerContinue(rp)),
      sequencerAbort: () => run("sequence", "git_sequencer_abort", (rp) => gitSequencerAbort(rp)),
      interactiveRebase: (base, entries) =>
        run("sequence", "git_interactive_rebase", (rp) => gitInteractiveRebase(rp, base, entries)),
    }),
    [run, currentBranch, can]
  )
}
