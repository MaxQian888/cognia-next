"use client"

/**
 * Loads + renders the diff for the selected working/staged file, wiring the
 * per-hunk gutter actions (Stage / Unstage / Discard Hunk) to the backend.
 *
 * Freshness: the store drops every working-tree and staged diff on each
 * status write (`setStatus`), which the fs watcher triggers on any relevant
 * edit. The cache miss re-enables the read below, so an agent's write or an
 * editor save shows up in the open diff instead of the diff from before it.
 *
 * One Monaco instance for the pane's lifetime. While a newly selected file
 * loads, the viewer keeps the last diff it had but is faded out and inert, and
 * the loading line (or the failure) sits on top. That way the previous file's
 * diff is never shown under the new file's name, and a click from file to
 * file does not tear down and rebuild the editor.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import { MessageSquarePlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { gitDiffFile } from "@/lib/git/commands"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { fileDiffKey, type GitDiff, type GitFileChange, type GitHunk } from "@/types/git"
import { useGitStore } from "@/stores/git/git-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useResizableLayout } from "@/hooks/ui/use-resizable-layout"
import { useDeferredLoading } from "@/hooks/ui/use-deferred-loading"
import { useGitRead } from "@/hooks/git/use-git-read"
import type { GitActionResult, UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { DiffLoading, DiffViewer, type HunkAction } from "./diff-viewer"
import { HunkReviewList } from "./hunk-review-list"
import { AiExplainPopover } from "./ai-explain-popover"
import { ReadError } from "./read-error"

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
  const cacheDiff = useGitStore((s) => s.cacheDiff)
  const invalidateDiff = useGitStore((s) => s.invalidateDiff)
  const statusStamp = useGitStore((s) => s.status)
  const [reviewCollapsed, setReviewCollapsed] = useState(false)
  const reviewLayout = useResizableLayout("cognia-git-diff-review")
  const fade = useReducedMotionTransition(mobileTransition("fast"))
  const can = actions.can ?? (() => true)

  // The working-tree change row backs the rename-aware review key. Fall back to
  // a plain modified change when the status row isn't found (e.g. mid-refresh).
  const change: GitFileChange =
    statusStamp?.changes.find((c) => c.path === path) ??
    statusStamp?.merge.find((c) => c.path === path) ??
    ({ path, origPath: null, status: "modified", staged: false, group: "changes" } as GitFileChange)

  // Subscribed, not read once: a status write that drops this entry must
  // re-render the pane so the read below re-enables.
  const key = fileDiffKey(path, staged)
  const cachedDiff = useGitStore((s) => s.diffCache[key])
  const readKey = `${rootDir}\u0000${key}`
  const read = useGitRead(readKey, () => gitDiffFile(rootDir, path, staged), {
    enabled: !cachedDiff,
    // A status write while this read is out means the file may have moved
    // again since the read started; restart it so the older answer is never
    // the one cached.
    revision: statusStamp,
    onData: (fresh) => {
      // Only into the repository it was read from: a read that lands after a
      // repo switch must not seed the next repository's cache.
      if (useGitStore.getState().rootDir === rootDir) cacheDiff(key, fresh)
    },
  })
  const loadingVisible = useDeferredLoading(read.loading, { key: readKey })

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

  const diff: GitDiff | null = cachedDiff ?? read.data ?? null
  // The last diff that loaded, so the viewer (and its Monaco instance) stays
  // mounted across a file switch. Adjusted during render, not in an effect.
  const [heldDiff, setHeldDiff] = useState<GitDiff | null>(diff)
  if (diff && diff !== heldDiff) setHeldDiff(diff)
  const viewerDiff = diff ?? heldDiff

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
      <div className="relative min-h-0 flex-1">
        {viewerDiff && (
          <motion.div
            className="h-full"
            initial={false}
            animate={{ opacity: diff ? 1 : 0 }}
            transition={fade}
            aria-hidden={diff ? undefined : true}
            inert={!diff}
            data-testid="diff-pane-viewer"
          >
            <DiffViewer
              diff={viewerDiff}
              staged={staged}
              hunkActions={hunkActions}
              density={density}
            />
          </motion.div>
        )}
        {!diff && (
          <div className="absolute inset-0" data-testid="diff-pane-pending">
            {read.error ? (
              <ReadError
                variant="block"
                message={read.error}
                onRetry={read.retry}
                testId="diff-load-error"
              />
            ) : loadingVisible ? (
              <DiffLoading />
            ) : null}
          </div>
        )}
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
