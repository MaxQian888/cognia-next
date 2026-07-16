"use client"

/**
 * Loads + renders the diff for the selected working/staged file, wiring the
 * per-hunk gutter actions (Stage / Unstage / Discard Hunk) to the backend.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { gitDiffFile } from "@/lib/git/commands"
import { fileDiffKey, type GitDiff, type GitFileChange, type GitHunk } from "@/types/git"
import { useGitStore } from "@/stores/git/git-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useResizableLayout } from "@/hooks/ui/use-resizable-layout"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { DiffViewer, type HunkAction } from "./diff-viewer"
import { HunkReviewList } from "./hunk-review-list"
import { AiExplainPopover } from "./ai-explain-popover"

interface DiffPaneProps {
  rootDir: string
  path: string
  staged: boolean
  actions: Pick<UseGitActionsResult, "stage" | "unstage" | "discard">
  density?: "compact" | "touch"
}

export function DiffPane({ rootDir, path, staged, actions, density = "compact" }: DiffPaneProps) {
  const t = useTranslations("sourceControl")
  const [fetched, setFetched] = useState<GitDiff | null>(null)
  const cacheDiff = useGitStore((s) => s.cacheDiff)
  const getCachedDiff = useGitStore((s) => s.getCachedDiff)
  const invalidateDiff = useGitStore((s) => s.invalidateDiff)
  // Re-fetch the diff whenever the status changes (e.g. after a hunk op).
  const statusStamp = useGitStore((s) => s.status)
  const [reviewCollapsed, setReviewCollapsed] = useState(false)
  const reviewLayout = useResizableLayout("cognia-git-diff-review")

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

  const explainEnabled = useSettingsStore(
    (s) => s.settings?.gitSettings?.explainAI?.enabled ?? false
  )
  const canExplain = explainEnabled && !!diff && !diff.isBinary && diff.hunks.length > 0

  // Explain toolbar + Monaco diff in one column so the bar stays pinned above.
  const viewer = (
    <div className="flex h-full min-h-0 flex-col">
      {canExplain && (
        <div className="flex shrink-0 items-center justify-end border-b px-2 py-1">
          <AiExplainPopover subject={path} diffText={diff.hunks.map((h) => h.patch).join("\n")} />
        </div>
      )}
      <div className="min-h-0 flex-1">
        <DiffViewer diff={diff} staged={staged} hunkActions={hunkActions} density={density} />
      </div>
    </div>
  )

  // Per-hunk review (accept/reject/comment) — working-tree files only.
  const showReview = !staged && !!diff && !diff.isBinary && diff.hunks.length > 0

  if (!showReview) {
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">{viewer}</div>
      </div>
    )
  }

  const review = (
    <HunkReviewList
      rootDir={rootDir}
      change={change}
      diff={diff}
      onStagePatch={(patch) => actions.stage([], patch)}
      onInvalidate={() => invalidateDiff(fileDiffKey(path, staged))}
      collapsed={reviewCollapsed}
      onToggleCollapse={() => setReviewCollapsed((c) => !c)}
      density={density}
    />
  )

  // Collapsed: the review shrinks to its header bar so the diff keeps the space.
  if (reviewCollapsed) {
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">{viewer}</div>
        {review}
      </div>
    )
  }

  // Expanded: a persisted vertical split so the review can be resized instead of
  // squeezing the diff above it.
  return (
    <ResizablePanelGroup
      orientation="vertical"
      defaultLayout={reviewLayout.defaultLayout}
      onLayoutChanged={reviewLayout.onLayoutChanged}
      className="h-full"
    >
      <ResizablePanel id="sc-diff-body" defaultSize="65%" minSize="25%">
        {viewer}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="sc-diff-review" defaultSize="35%" minSize="15%">
        {review}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
