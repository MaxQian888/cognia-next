"use client"

/**
 * WorkspaceReview — the dock workspace's Review surface: the changed-file
 * list and one file's diff, laid out by the room the dock actually has.
 *
 * - Wide (the dock's own width ≥ {@link REVIEW_SPLIT_MIN_WIDTH}): list and diff
 *   side by side, the split persisted.
 * - Narrow, and always on a phone: one pane at a time. Picking a file opens its
 *   diff; the diff's toolbar carries Back plus previous / next file, so a
 *   review is read file after file without returning to the list. This
 *   replaced a fixed 38/62 split that at the dock's 480px floor left the list
 *   ~180px and the diff ~300px, and a phone's Changes | Diff tab pair whose Diff
 *   tab was blank until a file had been picked on the other one.
 *
 * Across both: the file a reveal names opens straight into its diff (on the
 * side that actually holds its change; `focus`), the first file is picked when a wide
 * review opens with nothing selected, a file that leaves the list (fully
 * staged, discarded) hands over to the one after it, Alt+↑ / Alt+↓ step
 * between files, and "Open in editor" lands on the file surface at the change.
 *
 * The list can narrow to the files this conversation changed
 * (`useConversationChangedPaths`: its edit tool calls plus the host's per-turn
 * record, shell writes included). The diffs themselves still compare against
 * the index / HEAD, and the scope bar says so. The commit box sits under the
 * list, so a review ends in a commit without leaving the dock; it always
 * commits everything staged, and says when that includes files the narrowed
 * list is not showing.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  MessageSquareIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ChangesView } from "@/components/source-control/changes-view"
import { CommitBox } from "@/components/source-control/commit-box"
import { DiffPane } from "@/components/source-control/diff-pane"
import { useElementWidth } from "@/hooks/use-element-width"
import { useResizableLayout } from "@/hooks/ui/use-resizable-layout"
import { useConversationChangedPaths } from "@/hooks/git/use-conversation-changed-paths"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { changedPathCount, scopeStatus } from "@/lib/git/conversation-scope"
import {
  orderedReviewFiles,
  reviewFileNeighbours,
  type ReviewFileRef,
} from "@/lib/git/diff-presentation"
import { cn } from "@/lib/utils"
import type { GitStatus } from "@/types/git"

/**
 * Below this dock width the list and the diff take turns. 720px leaves a
 * 260px list beside a 460px diff — the narrowest pair where both stay usable.
 */
export const REVIEW_SPLIT_MIN_WIDTH = 720

/** Which changes the list shows. */
export type ReviewScope = "all" | "conversation"

export interface WorkspaceReviewProps {
  rootPath: string
  /**
   * The conversation the dock belongs to; enables "This conversation" in the
   * scope bar. Without one the list is the whole working tree, as before.
   */
  sessionId?: string | null
  status: GitStatus | null
  actions: UseGitActionsResult
  committing: boolean
  /** The git store's selection (shared with the Source Control page). */
  selected: ReviewFileRef | null
  onSelect: (file: ReviewFileRef | null) => void
  layout: "desktop" | "mobile"
  onSendToChat?: (payload: { path: string; diffText: string }) => void
  /** Open a file on the workspace's file surface, at a line when known. */
  onOpenInEditor?: (path: string, line?: number) => void
  /**
   * A reveal that named a file (a chat "Review" on one edit). Each new `id`
   * opens that file's diff, in the stacked layout too. Without one, a stacked
   * review opens on the list — a selection left over from an earlier visit is
   * not a request to read it.
   */
  focus?: { id: string; file: ReviewFileRef } | null
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

export function WorkspaceReview({
  rootPath,
  sessionId = null,
  status,
  actions,
  committing,
  selected,
  onSelect,
  layout,
  onSendToChat,
  onOpenInEditor,
  focus = null,
}: WorkspaceReviewProps) {
  const t = useTranslations("artifacts.workspace")
  const rootRef = useRef<HTMLDivElement | null>(null)
  const width = useElementWidth(rootRef)
  const touch = layout === "mobile"
  // 0 means "not measured yet" (and is all jsdom ever reports): keep the
  // desktop default rather than flashing the stacked layout.
  const stacked = touch || (width > 0 && width < REVIEW_SPLIT_MIN_WIDTH)
  const splitLayout = useResizableLayout("cognia-dock-review-split")

  // ── Scope: the whole working tree, or what this conversation changed ──
  const [scope, setScope] = useState<ReviewScope>("all")
  const conversation = useConversationChangedPaths(sessionId, rootPath)
  const canScope = Boolean(sessionId)
  const activeScope: ReviewScope = canScope ? scope : "all"
  const scopedStatus = useMemo(
    () =>
      status && activeScope === "conversation" ? scopeStatus(status, conversation.paths) : status,
    [status, activeScope, conversation.paths]
  )
  const allCount = useMemo(() => changedPathCount(status), [status])
  const conversationCount = useMemo(
    () => (status && canScope ? changedPathCount(scopeStatus(status, conversation.paths)) : 0),
    [status, canScope, conversation.paths]
  )
  // Staged files the narrowed list hides still go into the commit.
  const hiddenStaged =
    status && scopedStatus && activeScope === "conversation"
      ? status.staged.length - scopedStatus.staged.length
      : 0

  const files = useMemo(() => orderedReviewFiles(scopedStatus), [scopedStatus])
  const { index, prev, next } = useMemo(
    () => reviewFileNeighbours(files, selected),
    [files, selected]
  )

  // Stacked layouts show one pane. A reveal naming a file opens its diff,
  // exactly like a tap in the list.
  const [pane, setPane] = useState<"list" | "detail">(focus ? "detail" : "list")
  const [seenFocus, setSeenFocus] = useState(focus?.id ?? null)
  if (focus && focus.id !== seenFocus) {
    setSeenFocus(focus.id)
    setPane("detail")
    // A reveal must land on its file: widen a narrowed list that hides it.
    if (
      activeScope === "conversation" &&
      !files.some((f) => f.path === focus.file.path && f.staged === focus.file.staged)
    ) {
      setScope("all")
    }
  }

  const open = useCallback(
    (file: ReviewFileRef) => {
      onSelect(file)
      setPane("detail")
    },
    [onSelect]
  )

  // A wide review with nothing picked opens on the first file instead of an
  // empty half. Stacked layouts start on the list, which is the overview.
  useEffect(() => {
    if (stacked || selected || files.length === 0) return
    onSelect(files[0])
  }, [stacked, selected, files, onSelect])

  // When the reviewed file leaves the list (its last hunk staged, discarded,
  // committed elsewhere), hand over to the file that took its place. Only
  // while its diff is on screen: a file staged from the stacked LIST must not
  // throw the reader into the next file's diff.
  const lastIndex = useRef(-1)
  const diffVisible = !stacked || pane === "detail"
  useEffect(() => {
    if (index !== -1) {
      lastIndex.current = index
      return
    }
    if (!diffVisible || !selected || !status || lastIndex.current === -1) return
    const at = lastIndex.current
    lastIndex.current = -1
    if (files.length === 0) {
      onSelect(null)
      return
    }
    onSelect(files[Math.min(at, files.length - 1)])
  }, [index, diffVisible, selected, status, files, onSelect])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || !event.altKey || event.shiftKey || event.metaKey) return
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
      if (isEditableTarget(event.target)) return
      const target = event.key === "ArrowUp" ? prev : next
      if (!target) return
      event.preventDefault()
      open(target)
    },
    [prev, next, open]
  )

  const navButton = cn("text-muted-foreground", touch ? "size-11" : "size-7")
  const leading = (
    <>
      {stacked ? (
        <Button
          type="button"
          variant="ghost"
          size={touch ? "sm" : "xs"}
          className={cn("shrink-0 gap-1 px-1.5", touch && "min-h-11 px-2")}
          onClick={() => setPane("list")}
          aria-label={t("reviewBack")}
          title={t("reviewBack")}
          data-testid="workspace-review-back"
        >
          <ArrowLeftIcon className="size-4" />
          <span className="hidden @2xl/diff:inline">{t("reviewChanges")}</span>
        </Button>
      ) : null}
      <div
        role="group"
        aria-label={t("reviewFileNav")}
        className="flex shrink-0 items-center"
        data-testid="workspace-review-file-nav"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={navButton}
          disabled={!prev}
          onClick={() => prev && open(prev)}
          aria-label={t("reviewPrevFile")}
          title={t("reviewPrevFile")}
          aria-keyshortcuts="Alt+ArrowUp"
          data-testid="workspace-review-prev-file"
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        {index >= 0 ? (
          <span
            className="min-w-[3.5ch] text-center font-mono text-[11px] text-muted-foreground tabular-nums"
            aria-label={t("reviewFilePositionLabel", { index: index + 1, total: files.length })}
            data-testid="workspace-review-file-position"
          >
            {t("reviewFilePosition", { index: index + 1, total: files.length })}
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={navButton}
          disabled={!next}
          onClick={() => next && open(next)}
          aria-label={t("reviewNextFile")}
          title={t("reviewNextFile")}
          aria-keyshortcuts="Alt+ArrowDown"
          data-testid="workspace-review-next-file"
        >
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>
    </>
  )

  const empty = (
    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
      {t("reviewEmpty")}
    </div>
  )

  const toggleItem = cn("gap-1 text-xs", touch ? "h-9 min-w-0 flex-1 px-3" : "h-6 px-2")
  const scopeBar = canScope ? (
    <div className="shrink-0 space-y-1 border-b px-1.5 py-1" data-testid="workspace-review-scope">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={activeScope}
        // An empty value (the pressed item clicked again) is ignored.
        onValueChange={(next) => {
          if (next === "all" || next === "conversation") setScope(next)
        }}
        aria-label={t("reviewScope.label")}
        className={cn(touch && "w-full")}
      >
        <ToggleGroupItem
          value="all"
          className={toggleItem}
          data-testid="workspace-review-scope-all"
          aria-label={t("reviewScope.allLabel", { count: allCount })}
        >
          <FolderGit2Icon className="size-3.5" />
          {t("reviewScope.all")}
          <span className="tabular-nums text-muted-foreground">{allCount}</span>
        </ToggleGroupItem>
        <ToggleGroupItem
          value="conversation"
          className={toggleItem}
          data-testid="workspace-review-scope-conversation"
          aria-label={t("reviewScope.conversationLabel", { count: conversationCount })}
        >
          <MessageSquareIcon className="size-3.5" />
          {t("reviewScope.conversation")}
          <span className="tabular-nums text-muted-foreground">{conversationCount}</span>
        </ToggleGroupItem>
      </ToggleGroup>
      {activeScope === "conversation" ? (
        <p
          className="px-0.5 text-[11px] text-muted-foreground"
          data-testid="workspace-review-scope-note"
        >
          {t("reviewScope.baseline")}
        </p>
      ) : null}
    </div>
  ) : null

  const commitFooter = status ? (
    <div className="shrink-0 border-t bg-muted/10" data-testid="workspace-review-commit">
      {hiddenStaged > 0 ? (
        <p
          className="px-2 pt-1.5 text-[11px] text-amber-700 dark:text-amber-300"
          data-testid="workspace-review-commit-hidden"
        >
          {t("reviewScope.commitIncludesHidden", { count: hiddenStaged })}
        </p>
      ) : null}
      <CommitBox
        rootDir={rootPath}
        stagedCount={status.staged.length}
        committing={committing}
        actions={actions}
        compact
        density={touch ? "touch" : "compact"}
      />
    </div>
  ) : null

  const scopedEmpty =
    activeScope === "conversation" && scopedStatus && files.length === 0 ? (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground"
        data-testid="workspace-review-scope-empty"
      >
        {conversation.ready ? t("reviewScope.empty") : t("reviewScope.loading")}
      </div>
    ) : null

  const list = scopedStatus ? (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace-review-list-pane">
      {scopeBar}
      {scopedEmpty ?? (
        <div className="min-h-0 flex-1">
          <ChangesView
            variant="review"
            rootDir={rootPath}
            actions={actions}
            status={scopedStatus}
            committing={committing}
            selectedPath={selected?.path ?? null}
            onSelectFile={(path, staged) => open({ path, staged })}
            density={touch ? "touch" : "compact"}
          />
        </div>
      )}
      {commitFooter}
    </div>
  ) : (
    empty
  )

  const detail = selected ? (
    <DiffPane
      // A remount per file would rebuild Monaco on every step; DiffPane keeps
      // one viewer and swaps its diff instead.
      rootDir={rootPath}
      path={selected.path}
      staged={selected.staged}
      actions={actions}
      density={touch ? "touch" : "compact"}
      onSendToChat={onSendToChat}
      onOpenInEditor={onOpenInEditor}
      leading={leading}
      reviewDefaultCollapsed={stacked}
    />
  ) : (
    empty
  )

  return (
    <div
      ref={rootRef}
      className="h-full min-h-0 min-w-0"
      data-testid="workspace-review"
      data-layout={stacked ? "stacked" : "split"}
      data-pane={stacked ? pane : undefined}
      onKeyDown={onKeyDown}
    >
      {stacked ? (
        pane === "detail" && selected ? (
          <div className="h-full min-h-0" data-testid="workspace-review-detail">
            {detail}
          </div>
        ) : (
          <div className="h-full min-h-0" data-testid="workspace-review-list">
            {list}
          </div>
        )
      ) : status ? (
        <ResizablePanelGroup
          orientation="horizontal"
          className="h-full"
          defaultLayout={splitLayout.defaultLayout}
          onLayoutChanged={splitLayout.onLayoutChanged}
        >
          <ResizablePanel id="workspace-review-changes" defaultSize="34%" minSize="22%">
            {list}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="workspace-review-diff" defaultSize="66%" minSize="40%">
            {detail}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        empty
      )}
    </div>
  )
}
