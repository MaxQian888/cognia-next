"use client"

/**
 * Loads + renders the diff for the selected working/staged file, wiring the
 * per-hunk gutter actions (Stage / Unstage / Discard Hunk) to the backend.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { gitDiffFile } from "@/lib/git/commands"
import { fileDiffKey, type GitDiff, type GitFileChange, type GitHunk } from "@/types/git"
import { useGitStore } from "@/stores/git/git-store"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { DiffViewer, type HunkAction } from "./diff-viewer"
import { HunkReviewList } from "./hunk-review-list"

interface DiffPaneProps {
  rootDir: string
  path: string
  staged: boolean
  actions: Pick<UseGitActionsResult, "stage" | "unstage" | "discard">
}

export function DiffPane({ rootDir, path, staged, actions }: DiffPaneProps) {
  const t = useTranslations("sourceControl")
  const [fetched, setFetched] = useState<GitDiff | null>(null)
  const cacheDiff = useGitStore((s) => s.cacheDiff)
  const getCachedDiff = useGitStore((s) => s.getCachedDiff)
  const invalidateDiff = useGitStore((s) => s.invalidateDiff)
  // Re-fetch the diff whenever the status changes (e.g. after a hunk op).
  const statusStamp = useGitStore((s) => s.status)

  // The working-tree change row backs the rename-aware review key. Fall back to
  // a plain modified change when the status row isn't found (e.g. mid-refresh).
  const change: GitFileChange =
    statusStamp?.changes.find((c) => c.path === path) ??
    statusStamp?.merge.find((c) => c.path === path) ??
    ({ path, origPath: null, status: "modified", staged: false, group: "changes" } as GitFileChange)

  // The cached diff is read during render; the effect only performs the async
  // fetch on a cache miss (avoids setState directly inside an effect body).
  const key = fileDiffKey(path, staged)
  const cachedDiff = getCachedDiff(key)

  useEffect(() => {
    if (cachedDiff) return
    let alive = true
    void gitDiffFile(rootDir, path, staged).then((d) => {
      if (!alive) return
      cacheDiff(key, d)
      setFetched(d)
    })
    return () => {
      alive = false
    }
  }, [rootDir, path, staged, key, cachedDiff, cacheDiff, statusStamp])

  const runHunk = useCallback(
    async (fn: (patch: string) => Promise<void>, hunk: GitHunk) => {
      await fn(hunk.patch)
      invalidateDiff(fileDiffKey(path, staged))
      // status refresh (triggered inside the action) re-runs `load`.
    },
    [invalidateDiff, path, staged]
  )

  const hunkActions: HunkAction[] = staged
    ? [
        {
          icon: "unstage",
          label: t("actions.unstageHunk"),
          onClick: (h) => void runHunk((p) => actions.unstage([], p), h),
        },
      ]
    : [
        {
          icon: "stage",
          label: t("actions.stageHunk"),
          onClick: (h) => void runHunk((p) => actions.stage([], p), h),
        },
        {
          icon: "discard",
          label: t("actions.discardHunk"),
          onClick: (h) => void runHunk((p) => actions.discard([], p), h),
        },
      ]

  const diff = cachedDiff ?? fetched

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <DiffViewer diff={diff} staged={staged} hunkActions={hunkActions} />
      </div>
      {/* Per-hunk review (accept/reject/comment) — working-tree files only. */}
      {!staged && diff && !diff.isBinary && diff.hunks.length > 0 && (
        <HunkReviewList
          rootDir={rootDir}
          change={change}
          diff={diff}
          onStagePatch={(patch) => actions.stage([], patch)}
          onInvalidate={() => invalidateDiff(fileDiffKey(path, staged))}
        />
      )}
    </div>
  )
}
