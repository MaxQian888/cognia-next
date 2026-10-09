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
 * The scope picker (`ReviewScopePicker`) says which diff is on screen. The
 * working-tree scopes stay here, with staging: Uncommitted, its Unstaged and
 * Staged halves, and This conversation, which narrows the list to the files
 * this conversation changed (`useConversationChangedPaths`: its edit tool calls
 * plus the host's per-turn record, shell writes included) while the diffs still
 * compare against the index / HEAD, as the scope bar says. A turn, a commit or
 * the branch against a base is not the working tree and hands over to the
 * read-only `SnapshotReview`. The commit box sits under the working-tree list,
 * so a review ends in a commit without leaving the dock; it always commits
 * everything staged, and says when that includes files the list is not showing.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ChangesView } from "@/components/source-control/changes-view"
import { CommitBox } from "@/components/source-control/commit-box"
import { DiffPane } from "@/components/source-control/diff-pane"
import { ReviewScopePicker } from "@/components/source-control/review-scope-picker"
import { isSnapshotSelection, SnapshotReview } from "./snapshot-review"
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
import type { ReviewScopeChoice } from "@/types/review"

/**
 * Below this dock width the list and the diff take turns. 720px leaves a
 * 260px list beside a 460px diff — the narrowest pair where both stay usable.
 */
export const REVIEW_SPLIT_MIN_WIDTH = 720

type WorkingTreeScope = "uncommitted" | "unstaged" | "staged" | "conversation"

/** The working-tree status a working-tree scope shows. */
export function statusForScope(
  status: GitStatus | null,
  scope: WorkingTreeScope,
  conversationPaths: ReadonlySet<string>
): GitStatus | null {
  if (!status) return status
  switch (scope) {
    case "staged":
      return { ...status, changes: [], merge: [] }
    case "unstaged":
      return { ...status, staged: [] }
    case "conversation":
      return scopeStatus(status, conversationPaths)
    default:
      return status
  }
}

export interface WorkspaceReviewProps {
  rootPath: string
  /**
   * The conversation the dock belongs to; enables "This conversation" and the
   * conversation's turns in the scope picker.
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
  /**
   * A reveal that named a scope (a turn card's "View changes"). Each new `id`
   * switches the review to it, opening `relPath` when the scope lists it.
   */
  scopeRequest?: { id: string; choice: ReviewScopeChoice; relPath?: string } | null
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
  scopeRequest = null,
}: WorkspaceReviewProps) {
  const t = useTranslations("artifacts.workspace")
  const rootRef = useRef<HTMLDivElement | null>(null)
  const width = useElementWidth(rootRef)
  const touch = layout === "mobile"
  // 0 means "not measured yet" (and is all jsdom ever reports): keep the
  // desktop default rather than flashing the stacked layout.
  const stacked = touch || (width > 0 && width < REVIEW_SPLIT_MIN_WIDTH)
  const splitLayout = useResizableLayout("cognia-dock-review-split")

  // ── Scope: which diff the review shows ──
  // A reveal that mounts the review brings its scope with it.
  const [choice, setChoice] = useState<ReviewScopeChoice>(
    () => scopeRequest?.choice ?? { scope: "uncommitted" }
  )
  const conversation = useConversationChangedPaths(sessionId, rootPath)
  const canScopeConversation = Boolean(sessionId)
  const activeChoice: ReviewScopeChoice =
    choice.scope === "conversation" && !canScopeConversation ? { scope: "uncommitted" } : choice
  const snapshot = isSnapshotSelection(activeChoice) ? activeChoice : null
  const workingScope: WorkingTreeScope = snapshot
    ? "uncommitted"
    : (activeChoice.scope as WorkingTreeScope)
  const scopedStatus = useMemo(
    () => statusForScope(status, workingScope, conversation.paths),
    [status, workingScope, conversation.paths]
  )
  const counts = useMemo(
    () => ({
      uncommitted: changedPathCount(status),
      unstaged: changedPathCount(statusForScope(status, "unstaged", conversation.paths)),
      staged: changedPathCount(statusForScope(status, "staged", conversation.paths)),
      ...(canScopeConversation
        ? {
            conversation: changedPathCount(
              statusForScope(status, "conversation", conversation.paths)
            ),
          }
        : {}),
    }),
    [status, canScopeConversation, conversation.paths]
  )
  // Staged files the narrowed list hides still go into the commit.
  const hiddenStaged =
    status && scopedStatus && workingScope !== "uncommitted"
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
    // A reveal must land on its file: widen a list that hides it, and leave a
    // snapshot (a file reveal is about the working tree). Not when the same
    // reveal also named a scope: that scope is what it asked for.
    if (
      scopeRequest?.id !== focus.id &&
      (snapshot || !files.some((f) => f.path === focus.file.path && f.staged === focus.file.staged))
    ) {
      setChoice({ scope: "uncommitted" })
    }
  }
  const [seenScopeRequest, setSeenScopeRequest] = useState(scopeRequest?.id ?? null)
  const [snapshotFocus, setSnapshotFocus] = useState<{ id: string; path: string } | null>(
    scopeRequest?.relPath ? { id: scopeRequest.id, path: scopeRequest.relPath } : null
  )
  if (scopeRequest && scopeRequest.id !== seenScopeRequest) {
    setSeenScopeRequest(scopeRequest.id)
    setChoice(scopeRequest.choice)
    setSnapshotFocus(
      scopeRequest.relPath ? { id: scopeRequest.id, path: scopeRequest.relPath } : null
    )
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

  const scopeBar = (
    <div className="shrink-0 space-y-1 border-b px-1.5 py-1" data-testid="workspace-review-scope">
      <ReviewScopePicker
        value={activeChoice}
        onChange={setChoice}
        rootDir={rootPath}
        sessionId={sessionId}
        allowConversation={canScopeConversation}
        counts={counts}
        density={touch ? "touch" : "compact"}
      />
      {activeChoice.scope === "conversation" ? (
        <p
          className="px-0.5 text-[11px] text-muted-foreground"
          data-testid="workspace-review-scope-note"
        >
          {t("reviewScope.baseline")}
        </p>
      ) : snapshot ? (
        <p
          className="px-0.5 text-[11px] text-muted-foreground"
          data-testid="workspace-review-scope-note"
        >
          {t(`snapshot.note.${snapshot.scope}`)}
        </p>
      ) : null}
    </div>
  )

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
    workingScope !== "uncommitted" && scopedStatus && files.length === 0 ? (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground"
        data-testid="workspace-review-scope-empty"
      >
        {workingScope !== "conversation"
          ? t(`snapshot.emptyWorkingTree.${workingScope}`)
          : conversation.ready
            ? t("reviewScope.empty")
            : t("reviewScope.loading")}
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

  if (snapshot) {
    return (
      <div
        ref={rootRef}
        className="h-full min-h-0 min-w-0"
        data-testid="workspace-review"
        data-layout={stacked ? "stacked" : "split"}
      >
        <SnapshotReview
          // A new target or a new reveal starts the snapshot over.
          key={`${JSON.stringify(snapshot)}:${snapshotFocus?.id ?? ""}`}
          rootPath={rootPath}
          selection={snapshot}
          focusPath={snapshotFocus?.path ?? null}
          stacked={stacked}
          touch={touch}
          header={scopeBar}
        />
      </div>
    )
  }

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
