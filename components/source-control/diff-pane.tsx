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
 *
 * Chrome is one toolbar row (the viewer's): the host's `leading` controls
 * (back / previous / next file in the dock), the file's name, folder and
 * +/− counts, the change navigator, then Send to chat and Explain. These used
 * to be two stacked bars — an action row and a chip row per hunk — above a
 * diff that, in a dock at its 480px floor, was left a sliver.
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import { MessageSquarePlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { gitDiffFile, gitReadBlobAtRef } from "@/lib/git/commands"
import { hunkStats } from "@/lib/git/diff-presentation"
import { loadFullGitDiff } from "@/lib/git/full-diff"
import { notifyProjectFileSaved } from "@/lib/files/project-editor-bridge"
import { joinProjectPath } from "@/hooks/codeserver/use-code-server-project-opener"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { readWorkspaceFile, writeWorkspaceFile } from "@/lib/files/workspace-fs"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { fileDiffKey, type GitDiff, type GitFileChange, type GitHunk } from "@/types/git"
import { diffEditKey, useGitStore } from "@/stores/git/git-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useResizableLayout } from "@/hooks/ui/use-resizable-layout"
import { useDeferredLoading } from "@/hooks/ui/use-deferred-loading"
import { useGitRead } from "@/hooks/git/use-git-read"
import { cn } from "@/lib/utils"
import type { GitActionResult, UseGitActionsResult } from "@/hooks/git/use-git-actions"
import {
  DiffLoading,
  DiffToolbar,
  DiffViewer,
  type DiffEditBinding,
  type DiffViewerHandle,
  type HunkAction,
} from "./diff-viewer"
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
  /**
   * Open the file in the host's editor at a modified-side line — wired to the
   * viewer's "open at this change" and to the line gutter of its lightweight
   * view. Optional for the same reason as `onSendToChat`: only a host with an
   * editor beside the diff can honour it.
   */
  onOpenInEditor?: (path: string, line?: number) => void
  /**
   * Host controls placed before the file name in the toolbar — the dock's
   * back-to-list and previous / next file buttons.
   */
  leading?: ReactNode
  /**
   * Start the per-hunk review list collapsed to its header. Hosts with little
   * height (a phone, a narrow stacked dock) give the diff the room first.
   */
  reviewDefaultCollapsed?: boolean
  /**
   * Let the reader edit a working-tree diff's modified side and save it to
   * disk. On by default where there is a workspace filesystem; the viewer
   * still only offers it in its Monaco view (never on a phone).
   */
  editable?: boolean
}

/** The file's name, its folder dimmed after it, and the change counts. */
function FileIdentity({
  path,
  added,
  removed,
}: {
  path: string
  added: number | null
  removed: number | null
}) {
  const slash = path.lastIndexOf("/")
  const name = slash === -1 ? path : path.slice(slash + 1)
  const dir = slash === -1 ? "" : path.slice(0, slash)
  return (
    <div
      className="flex min-w-0 items-baseline gap-1.5 px-1"
      title={path}
      data-testid="diff-file-identity"
    >
      {/* The name keeps a readable minimum; the folder gives way first. */}
      <span className="min-w-[8ch] truncate text-xs font-medium">{name}</span>
      {dir ? (
        <span className="hidden min-w-0 shrink-[100] truncate text-[11px] text-muted-foreground @xl/diff:inline">
          {dir}
        </span>
      ) : null}
      {added !== null && removed !== null ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums" data-testid="diff-file-stats">
          <span className="text-green-600 dark:text-green-400">+{added}</span>{" "}
          <span className="text-red-600 dark:text-red-400">-{removed}</span>
        </span>
      ) : null}
    </div>
  )
}

export function DiffPane({
  rootDir,
  path,
  staged,
  actions,
  density = "compact",
  onSendToChat,
  onOpenInEditor,
  leading,
  reviewDefaultCollapsed = false,
  editable = true,
}: DiffPaneProps) {
  const t = useTranslations("sourceControl")
  const cacheDiff = useGitStore((s) => s.cacheDiff)
  const invalidateDiff = useGitStore((s) => s.invalidateDiff)
  const statusStamp = useGitStore((s) => s.status)
  const [reviewCollapsed, setReviewCollapsed] = useState(reviewDefaultCollapsed)
  // The viewer and the hunk review are one surface: the review follows the
  // change the reader is on and reveals its hunks in the viewer.
  const viewerRef = useRef<DiffViewerHandle | null>(null)
  const [currentHunk, setCurrentHunk] = useState(-1)
  const revealHunk = useCallback((index: number) => viewerRef.current?.revealHunk(index), [])
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

  const loadedDiff: GitDiff | null = cachedDiff ?? read.data ?? null
  // A hunks-only diff whose full texts were rebuilt on request ("Load whole
  // file"). Tied to the exact diff it was built from: the next refresh brings
  // hunks-only again, and the reader asks again rather than seeing texts
  // rebuilt from hunks that are no longer current.
  const [fullDiff, setFullDiff] = useState<{ from: GitDiff; full: GitDiff } | null>(null)
  const diff: GitDiff | null =
    loadedDiff && fullDiff?.from === loadedDiff ? fullDiff.full : loadedDiff
  // The last diff that loaded, so the viewer (and its Monaco instance) stays
  // mounted across a file switch. Adjusted during render, not in an effect.
  const [heldDiff, setHeldDiff] = useState<GitDiff | null>(diff)
  if (diff && diff !== heldDiff) setHeldDiff(diff)
  const viewerDiff = diff ?? heldDiff

  const loadOmitted = useCallback(async () => {
    const source = loadedDiff
    if (!source?.contentOmitted) return
    const full = await loadFullGitDiff(source, staged, {
      readWorkingFile: () => readWorkspaceFile(rootDir, path),
      readHeadBlob: () => gitReadBlobAtRef(rootDir, "HEAD", path),
    })
    setFullDiff({ from: source, full })
  }, [loadedDiff, staged, rootDir, path])

  // Editing writes the working tree, so only the working-tree side, and only
  // where a filesystem backend can take the write.
  const canEdit = editable && !staged && density !== "touch" && hasWorkspaceFsBackend()
  const edit = useMemo<DiffEditBinding | undefined>(
    () =>
      canEdit
        ? {
            draftKey: diffEditKey(rootDir, path),
            save: async (content, expectedDisk) => {
              if (expectedDisk !== null) {
                const disk = await readWorkspaceFile(rootDir, path)
                if (disk !== expectedDisk) return "conflict"
              }
              await writeWorkspaceFile(rootDir, path, content)
              // An editor tab on the same file learns it was written here.
              notifyProjectFileSaved(joinProjectPath(rootDir, path))
              invalidateDiff(fileDiffKey(path, staged))
              return "saved"
            },
          }
        : undefined,
    [canEdit, rootDir, path, staged, invalidateDiff]
  )

  const explainEnabled = useSettingsStore(
    (s) => s.settings?.gitSettings?.explainAI?.enabled ?? false
  )
  const hasHunks = !!diff && !diff.isBinary && diff.hunks.length > 0
  const canExplain = explainEnabled && hasHunks
  // Joined once per diff, not per render: a large patch is megabytes of text.
  const diffText = useMemo(
    () => (diff && !diff.isBinary ? diff.hunks.map((h) => h.patch).join("\n") : ""),
    [diff]
  )
  // Gated on the host supplying a sink, not on the Explain setting — the two
  // are independent, and hanging this off `explainAI.enabled` would hide the
  // route to chat behind an unrelated toggle.
  const canSendToChat = Boolean(onSendToChat) && hasHunks

  // Counts from the hunks the host already parsed — no second diff pass. From
  // the CURRENT diff only, so a held previous file never lends its numbers to
  // the name of the one loading.
  const stats = useMemo(() => (diff && !diff.isBinary ? hunkStats(diff.hunks) : null), [diff])
  const touch = density === "touch"
  // Words only once the row has room for them after the file's name.
  const labelClass = "hidden @2xl/diff:inline"
  const toolbarStart = (
    <>
      {leading}
      <FileIdentity path={path} added={stats?.added ?? null} removed={stats?.removed ?? null} />
    </>
  )
  const toolbarEnd =
    canSendToChat || canExplain ? (
      <>
        {canSendToChat && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className={cn(touch && "min-h-11 px-3")}
            data-testid="diff-send-to-chat"
            aria-label={t("sendDiffToChat")}
            title={t("sendDiffToChat")}
            onClick={() => onSendToChat?.({ path, diffText })}
          >
            <MessageSquarePlusIcon className="size-3.5" />
            <span className={labelClass}>{t("sendDiffToChat")}</span>
          </Button>
        )}
        {canExplain && <AiExplainPopover subject={path} diffText={diffText} />}
      </>
    ) : null

  const viewer = (
    <div className="relative h-full min-h-0">
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
            ref={viewerRef}
            diff={viewerDiff}
            staged={staged}
            hunkActions={hunkActions}
            density={density}
            toolbarStart={toolbarStart}
            toolbarEnd={toolbarEnd}
            onOpenLine={onOpenInEditor ? (line) => onOpenInEditor(path, line) : undefined}
            edit={edit}
            onLoadOmitted={loadedDiff?.contentOmitted ? loadOmitted : undefined}
            onCurrentChange={setCurrentHunk}
          />
        </motion.div>
      )}
      {!diff && (
        <div
          className="absolute inset-0 flex flex-col bg-background"
          data-testid="diff-pane-pending"
        >
          {/* The held viewer underneath is faded out and inert, and on the
              first load there is none, so the pending layer carries its own
              toolbar: the host's controls (Back, previous / next file) and
              the new file's name stay put while it loads. */}
          <DiffToolbar touch={touch} start={toolbarStart} />
          <div className="relative min-h-0 flex-1">
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
        </div>
      )}
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
      hunkActions={hunkActions}
      currentIndex={currentHunk}
      onReveal={revealHunk}
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
