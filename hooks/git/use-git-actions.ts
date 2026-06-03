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
  gitCommit,
  gitCreateBranch,
  gitCreateTag,
  gitDeleteBranch,
  gitDeleteTag,
  gitPushTag,
  gitDiscard,
  gitDiscardAll,
  gitFetch,
  gitMergeAbort,
  gitPull,
  gitPush,
  gitRemoteAdd,
  gitRemoteRemove,
  gitRenameBranch,
  gitReset,
  gitResolveConflict,
  gitRestore,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashPop,
  gitStashPush,
  gitSync,
  gitUnstage,
} from "@/lib/git/commands"
import { asGitError, type ConflictSide, type GitResetMode } from "@/types/git"
import { useGitStore, type GitOp } from "@/stores/git/git-store"

const OP_ERROR_KEY: Partial<Record<GitOp, string>> = {
  commit: "commitFailed",
  push: "pushFailed",
  pull: "pullFailed",
  checkout: "checkoutFailed",
}

export interface UseGitActionsResult {
  stage: (paths: string[], hunkPatch?: string) => Promise<void>
  unstage: (paths: string[], hunkPatch?: string) => Promise<void>
  discard: (paths: string[], hunkPatch?: string) => Promise<void>
  discardAll: (includeUntracked: boolean) => Promise<void>
  commit: (message: string, options?: { amend?: boolean; signoff?: boolean }) => Promise<void>
  checkout: (name: string) => Promise<void>
  createBranch: (name: string, checkout: boolean, from?: string) => Promise<void>
  deleteBranch: (name: string, force: boolean) => Promise<void>
  renameBranch: (newName: string, old?: string) => Promise<void>
  fetch: () => Promise<void>
  pull: () => Promise<void>
  push: (setUpstream?: boolean) => Promise<void>
  sync: () => Promise<void>
  stashPush: (options?: {
    message?: string
    includeUntracked?: boolean
    keepIndex?: boolean
  }) => Promise<void>
  stashPop: (index: number) => Promise<void>
  stashApply: (index: number) => Promise<void>
  stashDrop: (index: number) => Promise<void>
  resolveConflict: (
    path: string,
    resolution: { mergedContent?: string; side?: ConflictSide }
  ) => Promise<void>
  mergeAbort: () => Promise<void>
  remoteAdd: (name: string, url: string) => Promise<void>
  remoteRemove: (name: string) => Promise<void>
  createTag: (name: string, message?: string, target?: string) => Promise<void>
  deleteTag: (name: string) => Promise<void>
  pushTag: (name: string, remote?: string) => Promise<void>
  reset: (mode: GitResetMode, target: string) => Promise<void>
  restore: (paths: string[], staged?: boolean, source?: string) => Promise<void>
}

export function useGitActions(refresh: () => Promise<void>): UseGitActionsResult {
  const t = useTranslations("sourceControl")
  const rootDir = useGitStore((s) => s.rootDir)
  const setOp = useGitStore((s) => s.setOp)
  const setError = useGitStore((s) => s.setError)
  const clearError = useGitStore((s) => s.clearError)
  const currentBranch = useGitStore((s) => s.status?.branch ?? null)

  const run = useCallback(
    async (op: GitOp, fn: (rp: string) => Promise<unknown>): Promise<void> => {
      if (!rootDir) return
      setOp(op, true)
      clearError()
      try {
        await fn(rootDir)
        await refresh()
      } catch (err) {
        const payload = asGitError(err)
        const message = payload?.detail ?? payload?.kind ?? String(err)
        setError(op, message)
        const key = OP_ERROR_KEY[op] ?? "generic"
        toast.error(t(`errors.${key}`, { message }))
      } finally {
        setOp(op, false)
      }
    },
    [rootDir, refresh, setOp, setError, clearError, t]
  )

  return useMemo<UseGitActionsResult>(
    () => ({
      stage: (paths, hunkPatch) => run("stage", (rp) => gitStage(rp, paths, hunkPatch)),
      unstage: (paths, hunkPatch) => run("stage", (rp) => gitUnstage(rp, paths, hunkPatch)),
      discard: (paths, hunkPatch) => run("discard", (rp) => gitDiscard(rp, paths, hunkPatch)),
      discardAll: (includeUntracked) => run("discard", (rp) => gitDiscardAll(rp, includeUntracked)),
      commit: (message, options) =>
        run("commit", (rp) =>
          gitCommit(rp, message, options?.amend ?? false, options?.signoff ?? false)
        ),
      checkout: (name) => run("checkout", (rp) => gitCheckoutBranch(rp, name)),
      createBranch: (name, checkout, from) =>
        run("branch", (rp) => gitCreateBranch(rp, name, checkout, from)),
      deleteBranch: (name, force) => run("branch", (rp) => gitDeleteBranch(rp, name, force)),
      renameBranch: (newName, old) => run("branch", (rp) => gitRenameBranch(rp, newName, old)),
      fetch: () => run("fetch", (rp) => gitFetch(rp)),
      pull: () => run("pull", (rp) => gitPull(rp)),
      push: (setUpstream) =>
        run("push", (rp) =>
          gitPush(rp, {
            setUpstream,
            branch: setUpstream ? (currentBranch ?? undefined) : undefined,
            remote: setUpstream ? "origin" : undefined,
          })
        ),
      sync: () => run("sync", (rp) => gitSync(rp)),
      stashPush: (options) => run("stash", (rp) => gitStashPush(rp, options)),
      stashPop: (index) => run("stash", (rp) => gitStashPop(rp, index)),
      stashApply: (index) => run("stash", (rp) => gitStashApply(rp, index)),
      stashDrop: (index) => run("stash", (rp) => gitStashDrop(rp, index)),
      resolveConflict: (path, resolution) =>
        run("resolve", (rp) => gitResolveConflict(rp, path, resolution)),
      mergeAbort: () => run("resolve", (rp) => gitMergeAbort(rp)),
      remoteAdd: (name, url) => run("remote", (rp) => gitRemoteAdd(rp, name, url)),
      remoteRemove: (name) => run("remote", (rp) => gitRemoteRemove(rp, name)),
      createTag: (name, message, target) =>
        run("tag", (rp) => gitCreateTag(rp, name, message, target)),
      deleteTag: (name) => run("tag", (rp) => gitDeleteTag(rp, name)),
      pushTag: (name, remote) => run("tag", (rp) => gitPushTag(rp, name, remote)),
      reset: (mode, target) => run("reset", (rp) => gitReset(rp, mode, target)),
      restore: (paths, staged, source) =>
        run("discard", (rp) => gitRestore(rp, paths, staged, source)),
    }),
    [run, currentBranch]
  )
}
