"use client"

/**
 * Loads + renders the diff for the selected working/staged file, wiring the
 * per-hunk gutter actions (Stage / Unstage / Discard Hunk) to the backend.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { MessageSquarePlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { gitDiffFile } from "@/lib/git/commands"
import { fileDiffKey, type GitDiff, type GitFileChange, type GitHunk } from "@/types/git"
import { useGitStore } from "@/stores/git/git-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useResizableLayout } from "@/hooks/ui/use-resizable-layout"
import type { GitActionResult, UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { DiffViewer, type HunkAction } from "./diff-viewer"
import { HunkReviewList } from "./hunk-review-list"
import { AiExplainPopover } from "./ai-explain-popover"

interface DiffPaneProps {
  rootDir: string
  path: string
  staged: boolean
  actions: {
    stage: (paths: string[], patch?: string) => Promise<GitActionResult | void>
    unstage: (paths: string[], patch?: string) => Promise<GitActionResult | void>
    discard: (paths: string[], patch?: string) => Promise<GitActionResult | void>
  } & Partial<Pick<UseGitActionsResult, "can">>
  density?: "compact" | "touch"
  /**
   * Stage this diff as context for the next chat message.
   *
   * Optional because only the chat dock's workspace has a conversation to hand
   * it to; the standalone source-control route omits it and the control is
   * absent there rather than present-and-inert. Distinct from the Explain
   * popover beside it, which answers in place and never reaches the chat.
   */
  onSendToChat?: (payload: { path: string; diffText: string }) => void
}

export function DiffPane({
  rootDir,
  path,
  staged,
  actions,
  density = "compact",
  onSendToChat,
}: DiffPaneProps) {
  const t = useTranslations("sourceControl")
  const [fetched, setFetched] = useState<GitDiff | null>(null)
  const cacheDiff = useGitStore((s) => s.cacheDiff)
  const getCachedDiff = useGitStore((s) => s.getCachedDiff)
  const invalidateDiff = useGitStore((s) => s.invalidateDiff)
  // Re-fetch the diff whenever the status changes (e.g. after a hunk op).
  const statusStamp = useGitStore((s) => s.status)
  const [reviewCollapsed, setReviewCollapsed] = useState(false)
  const reviewLayout = useResizableLayout("cognia-git-diff-review")
  const can = actions.can ?? (() => true)

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
    async (fn: (patch: string) => Promise<GitActionResult | void>, hunk: GitHunk) => {
      const failure = await fn(hunk.patch)
      if (failure) return
      invalidateDiff(fileDiffKey(path, staged))
      // status refresh (triggered inside the action) re-runs `load`.
    },
    [invalidateDiff, path, staged]
  )

  const hunkActions: HunkAction[] = staged
    ? can("git_unstage")
      ? [
          {
            icon: "unstage",
            label: t("actions.unstageHunk"),
            onClick: (h) => void runHunk((p) => actions.unstage([], p), h),
          },
        ]
      : []
    : [
        ...(can("git_stage")
          ? [
              {
                icon: "stage",
                label: t("actions.stageHunk"),
                onClick: (h) => void runHunk((p) => actions.stage([], p), h),
              } satisfies HunkAction,
            ]
          : []),
        ...(can("git_discard")
          ? [
              {
                icon: "discard",
                label: t("actions.discardHunk"),
                onClick: (h) => void runHunk((p) => actions.discard([], p), h),
              } satisfies HunkAction,
            ]
          : []),
      ]

  const diff = cachedDiff ?? fetched

  const explainEnabled = useSettingsStore(
    (s) => s.settings?.gitSettings?.explainAI?.enabled ?? false
  )
  const hasHunks = !!diff && !diff.isBinary && diff.hunks.length > 0
  const canExplain = explainEnabled && hasHunks
  const diffText = hasHunks ? diff.hunks.map((h) => h.patch).join("\n") : ""
  // Gated on the host supplying a sink, not on the Explain setting — the two
  // are independent, and hanging this off `explainAI.enabled` would hide the
  // route to chat behind an unrelated toggle.
  const canSendToChat = Boolean(onSendToChat) && hasHunks

  // Toolbar + Monaco diff in one column so the bar stays pinned above.
  const viewer = (
    <div className="flex h-full min-h-0 flex-col">
      {(canExplain || canSendToChat) && (
        <div className="flex shrink-0 items-center justify-end gap-1 border-b px-2 py-1">
          {canSendToChat && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-testid="diff-send-to-chat"
              onClick={() => onSendToChat?.({ path, diffText })}
            >
              <MessageSquarePlusIcon className="size-3.5" />
              {t("sendDiffToChat")}
            </Button>
          )}
          {canExplain && <AiExplainPopover subject={path} diffText={diffText} />}
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
      canStage={can("git_stage")}
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
