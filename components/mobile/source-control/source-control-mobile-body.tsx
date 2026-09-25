"use client"

/**
 * `/source-control` on a phone.
 *
 * The desktop panel is a `ResizablePanelGroup`: changes on the left, diff on
 * the right. Two resizable panes in 375px is not a layout, it is two unusable
 * columns, which is why this route had no compact branch and rendered the
 * split anyway.
 *
 * Nothing about git is re-modelled. `BranchHeader`, `ChangesView`, `CommitBox`,
 * `DiffPane`, `ConflictResolver`, `TimelineView`, `CommitDetail`, `StashPanel`
 * and the status banners are the same components the desktop renders, reading
 * the same `useGitStore` and driven by the same `useGitActions`, so a file can
 * never be staged here and unstaged there. What changes is only which of them
 * is on screen: the change list IS the page, and a file, a conflict or a
 * commit arrives as a drawer.
 *
 * `density="touch"` on list, diff, conflict resolver and banners: the stage /
 * unstage / discard targets grow, the diff drops to a single-column hunk view,
 * and the conflict diff renders inline.
 *
 * `variant="review"` rather than `"panel"`, because `"panel"` is what makes
 * `ChangesView` render a `CommitBox` of its own at the TOP of the list. This
 * screen pins its own at the bottom, and passing `"panel"` put two live commit
 * boxes on the page: same draft, separate sign-off, identity-dialog and
 * history state, either one able to commit.
 *
 * What the phone has, beyond the list:
 *  - the merge / rebase "in progress" strip with Continue and Abort, because a
 *    rebase stopped on a conflict otherwise has no way out on this screen;
 *  - the conflict resolver for a conflicted file, not a plain diff of it;
 *  - pull (honouring the pull-rebase preference), push, or publish when the
 *    branch has no upstream yet, each carrying its count and its busy state;
 *  - Sync, the Timeline and Stashes behind a "more" menu. The timeline and
 *    stash sheets are `w-full` below 640px, i.e. full-screen here, and the
 *    timeline hides its graph view, which has no width to draw in. A picked
 *    commit closes the timeline and opens in a drawer, never behind it.
 *
 * Deliberately absent: remotes, tags, compare and interactive rebase. Each is
 * a multi-field or multi-pane editing surface, and offering a trigger that
 * opens an unusable dialog is worse than not offering it. Worktrees and stacks
 * are here through the repository navigator, whose inventory degrades to cards
 * below 640px on its own measured width.
 */

import { useCallback, useId, useState } from "react"
import { useTranslations } from "next-intl"
import { LayoutGroup, motion } from "motion/react"
import {
  AlertTriangleIcon,
  ArchiveIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  FolderOpenIcon,
  GitBranchIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SparklesIcon,
  UploadCloudIcon,
} from "lucide-react"

import { BranchHeader } from "@/components/source-control/branch-header"
import { RepositoryNavigator } from "@/components/source-control/repository-navigator"
import { ChangesView } from "@/components/source-control/changes-view"
import { CommitBox } from "@/components/source-control/commit-box"
import { CommitDetail } from "@/components/source-control/commit-detail"
import { ConflictResolver } from "@/components/source-control/conflict-resolver"
import { DiffPane } from "@/components/source-control/diff-pane"
import { StashPanel } from "@/components/source-control/stash-panel"
import { SequencerBanner, StaleStatusBanner } from "@/components/source-control/status-banners"
import { TimelineView } from "@/components/source-control/timeline-view"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { cn } from "@/lib/utils"
import { commitShell } from "@/lib/git/commit-shell"
import { MOBILE_SPRING, mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useGitActions } from "@/hooks/git/use-git-actions"
import { useGitRepo } from "@/hooks/git/use-git-repo"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"
import { useDeferredLoading } from "@/hooks/ui/use-deferred-loading"
import { useGitStore } from "@/stores/git/git-store"

const VIEWS = ["changes", "browse"] as const

interface SourceControlMobileBodyProps {
  /**
   * Open the diff drawer on mount for the stored selection. Set by the route
   * when it arrived with `?path=`, i.e. someone linked to one file; a plain
   * return to this screen leaves it closed (see `diffOpen` below).
   */
  initialDiffOpen?: boolean
}

export function SourceControlMobileBody({ initialDiffOpen = false }: SourceControlMobileBodyProps) {
  const t = useTranslations("sourceControl")
  const { available, rootDir, refresh, openFolder, remote } = useGitRepo()
  const actions = useGitActions(refresh)
  const can = actions.can ?? (() => true)
  const { prefs } = useSourceControlPrefs()

  const repoState = useGitStore((s) => s.repoState)
  const status = useGitStore((s) => s.status)
  const loadError = useGitStore((s) => s.loadError)
  const loadingStatus = useGitStore((s) => s.loadingStatus)
  const branches = useGitStore((s) => s.branches)
  const stashes = useGitStore((s) => s.stashes)
  const conflicts = useGitStore((s) => s.conflicts)
  const selectedPath = useGitStore((s) => s.selectedPath)
  const selectedStaged = useGitStore((s) => s.selectedStaged)
  const selectedCommit = useGitStore((s) => s.selectedCommit)
  const timelineRepo = useGitStore((s) => s.timelineRepo)
  const timelineFile = useGitStore((s) => s.timelineFile)
  const selectFile = useGitStore((s) => s.selectFile)
  const selectCommit = useGitStore((s) => s.selectCommit)
  const ops = useGitStore((s) => s.ops)
  const committing = ops.commit

  /**
   * The diff opens on a tap, not on the store's selection.
   *
   * Selection survives navigation, and the desktop reopens on it, so deriving
   * "open" from it would pop the drawer every time the user returns to this
   * page. Same reasoning as `devices-mobile-body`. The one exception is a link
   * that named the file (`initialDiffOpen`).
   */
  const [diffOpen, setDiffOpen] = useState(initialDiffOpen)
  // Which body: the change list, or the repository navigator. Same two views
  // the desktop panel offers, so a phone is not a different product.
  const [view, setView] = useState<(typeof VIEWS)[number]>("changes")
  const [timelineOpen, setTimelineOpen] = useState(false)
  // The file whose history the timeline opened on, or null for the repository.
  const [historyPath, setHistoryPath] = useState<string | null>(null)
  const [stashOpen, setStashOpen] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)

  // Hooks before the early returns below.
  const skeletonVisible = useDeferredLoading(!status && !loadError, { key: rootDir })
  const tabGroup = useId()
  const underline = useReducedMotionTransition(MOBILE_SPRING)
  const fade = useReducedMotionTransition(mobileTransition("fast"))

  const onSelectFile = useCallback(
    (path: string, staged: boolean) => {
      selectFile(path, staged)
      setDiffOpen(true)
    },
    [selectFile]
  )
  const openTimeline = useCallback((path: string | null) => {
    setHistoryPath(path)
    setTimelineOpen(true)
  }, [])
  // A failed refresh is already on screen (the stale strip, or the error
  // state); the rejection itself has nowhere further to go.
  const refreshSafely = useCallback(() => refresh().catch(() => undefined), [refresh])

  if (!available) {
    return (
      <Empty className="h-full border-0" data-testid="sc-mobile-unavailable">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranchIcon />
          </EmptyMedia>
          <EmptyTitle>{t("desktopOnly.title")}</EmptyTitle>
          <EmptyDescription>{t("desktopOnly.description")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (!rootDir) {
    return (
      <Empty className="h-full border-0" data-testid="sc-mobile-no-folder">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderOpenIcon />
          </EmptyMedia>
          <EmptyTitle>
            {remote ? t("remote.noWorkspace") : t("emptyState.noFolder")}
          </EmptyTitle>
          {remote ? <EmptyDescription>{t("remote.noWorkspaceDescription")}</EmptyDescription> : null}
        </EmptyHeader>
        {/* A phone paired to a host has no folder picker of its own: the
            workspace is chosen on the machine holding the repository. Only the
            local case gets the button, and the remote case gets the sentence
            above instead of a control that would open nothing. */}
        {remote ? null : (
          <EmptyContent className="flex-row gap-2">
            <Button onClick={() => void openFolder()} data-testid="sc-mobile-open-folder">
              {t("emptyState.openFolder")}
            </Button>
          </EmptyContent>
        )}
      </Empty>
    )
  }

  if (repoState && !repoState.isRepo) {
    return (
      <Empty className="h-full border-0" data-testid="sc-mobile-not-a-repo">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranchIcon />
          </EmptyMedia>
          <EmptyDescription>{t("emptyState.notARepo")}</EmptyDescription>
        </EmptyHeader>
        {/* The folder is bound, so turning it into a repository is one tap
            and needs nothing a phone lacks. Same action as the desktop. */}
        <EmptyContent>
          <Button
            className="min-h-11"
            onClick={() => void actions.init()}
            disabled={ops.init || !can("git_init")}
            data-testid="sc-mobile-init"
          >
            {ops.init ? <Spinner className="size-4" /> : <SparklesIcon className="size-4" />}
            {t("emptyState.initRepo")}
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  const stagedCount = status?.staged.length ?? 0
  const ahead = status?.ahead ?? 0
  const behind = status?.behind ?? 0
  // A checked-out branch with no upstream pushes nowhere; publish it instead.
  // The same rule as the desktop toolbar.
  const needsPublish = status !== null && status.branch !== null && status.upstream === null
  const conflict = selectedPath ? conflicts.find((c) => c.path === selectedPath) : undefined
  const pickedCommit = selectedCommit
    ? commitShell(selectedCommit, [timelineRepo, timelineFile])
    : null

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="source-control-mobile-body">
      <header className="safe-area-pt flex shrink-0 items-center gap-1 border-b px-2 py-2">
        <BranchHeader
          branch={status?.branch ?? null}
          ahead={ahead}
          behind={behind}
          branches={branches}
          actions={actions}
        />
        <div className="flex-1" />
        {/* Pull and push carry their counts, because on a phone the reason to
            open this screen is usually "is there anything to pull". */}
        <Button
          size="sm"
          variant="ghost"
          className="h-9 gap-1 px-2 text-xs"
          disabled={ops.pull || !can("git_pull")}
          aria-label={t("actions.pull")}
          onClick={() => void actions.pull({ rebase: prefs.pullRebase })}
          data-testid="sc-mobile-pull"
        >
          {ops.pull ? <Spinner className="size-4" /> : <ArrowDownToLineIcon className="size-4" />}
          {behind > 0 ? behind : null}
        </Button>
        {needsPublish ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-9 gap-1 px-2 text-xs"
            disabled={ops.push || !can("git_push")}
            aria-label={t("actions.publish")}
            onClick={() => void actions.push({ setUpstream: true })}
            data-testid="sc-mobile-publish"
          >
            {ops.push ? <Spinner className="size-4" /> : <UploadCloudIcon className="size-4" />}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-9 gap-1 px-2 text-xs"
            disabled={ops.push || !can("git_push")}
            aria-label={t("actions.push")}
            onClick={() => void actions.push()}
            data-testid="sc-mobile-push"
          >
            {ops.push ? <Spinner className="size-4" /> : <ArrowUpFromLineIcon className="size-4" />}
            {ahead > 0 ? ahead : null}
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-9"
          aria-label={t("actions.refresh")}
          onClick={() => void refreshSafely()}
          data-testid="sc-mobile-refresh"
        >
          <RefreshCwIcon className={cn("size-4", loadingStatus && "animate-spin")} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-9"
              aria-label={t("actions.more")}
              data-testid="sc-mobile-more"
            >
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              className="min-h-11"
              disabled={ops.sync || !can("git_sync")}
              onSelect={() => void actions.sync()}
              data-testid="sc-mobile-sync"
            >
              <RefreshCwIcon className="size-4" />
              {t("actions.sync")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* preventDefault on overlay-opening items: opening a Sheet from a
                closing menu races Radix focus restore (sticky pointer-events),
                exactly as in the desktop toolbar. */}
            <DropdownMenuItem
              className="min-h-11"
              disabled={!can("git_log")}
              onSelect={(e) => {
                e.preventDefault()
                openTimeline(null)
              }}
              data-testid="sc-mobile-timeline"
            >
              <HistoryIcon className="size-4" />
              {t("timeline.title")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11"
              disabled={!can("git_stash_list")}
              onSelect={(e) => {
                e.preventDefault()
                setStashOpen(true)
              }}
              data-testid="sc-mobile-stash"
            >
              <ArchiveIcon className="size-4" />
              {t("stash.title")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <SequencerBanner
        operation={repoState?.operationInProgress ?? null}
        actions={actions}
        density="touch"
      />
      <StaleStatusBanner
        message={loadError && status ? loadError : null}
        onRetry={() => void refreshSafely()}
        density="touch"
      />

      <LayoutGroup id={tabGroup}>
        <div
          role="tablist"
          aria-label={t("views.label")}
          className="flex shrink-0 border-b"
          data-testid="sc-mobile-views"
        >
          {VIEWS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={view === candidate}
              onClick={() => setView(candidate)}
              className={cn(
                "relative min-h-11 flex-1 px-3 text-xs text-muted-foreground transition-colors active:bg-accent",
                view === candidate && "font-medium text-foreground"
              )}
              data-testid={`sc-mobile-view-${candidate}`}
            >
              {t(`views.${candidate}`)}
              {/* One underline that slides to the tapped tab. */}
              {view === candidate && (
                <motion.span
                  layoutId="sc-mobile-view-underline"
                  transition={underline}
                  aria-hidden
                  className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary"
                  data-testid="sc-mobile-view-underline"
                />
              )}
            </button>
          ))}
        </div>
      </LayoutGroup>

      <motion.div
        key={view}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={fade}
        className="flex min-h-0 flex-1 flex-col"
      >
        {view === "browse" ? (
          <div className="min-h-0 flex-1">
            <RepositoryNavigator
              rootDir={rootDir}
              branches={branches}
              actions={actions}
              canMutate={actions.can}
            />
          </div>
        ) : !status && loadError ? (
          // Nothing loaded and the read failed. The skeleton used to stay up
          // here for good, which says "still loading" about a read that is
          // over.
          <Empty className="min-h-0 flex-1 border-0" data-testid="sc-mobile-load-error">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlertTriangleIcon />
              </EmptyMedia>
              <EmptyTitle>{t("repository.errorTitle")}</EmptyTitle>
              <EmptyDescription className="break-words">{loadError}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                className="min-h-11"
                onClick={() => void refreshSafely()}
                data-testid="sc-mobile-load-retry"
              >
                <RefreshCwIcon className="size-4" />
                {t("repository.retry")}
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            {/* `status` is null until the first load resolves, and
                `ChangesView` requires it. An empty list here would read as
                "no changes", which is the one thing it must not say while it
                does not know. */}
            {status ? (
              <PullToRefresh onRefresh={refreshSafely} className="min-h-0 flex-1">
                <ChangesView
                  variant="review"
                  density="touch"
                  rootDir={rootDir}
                  status={status}
                  actions={actions}
                  committing={committing}
                  selectedPath={selectedPath}
                  onSelectFile={onSelectFile}
                  // A row's context menu (a long press on touch) reaches the
                  // file's own history, as on the desktop.
                  onViewHistory={can("git_log") ? (path) => openTimeline(path) : undefined}
                />
              </PullToRefresh>
            ) : (
              <div
                role="status"
                aria-label={t("repository.loading")}
                className="min-h-0 flex-1 px-3 py-6"
                data-testid="sc-mobile-loading"
              >
                {skeletonVisible ? (
                  <div aria-hidden>
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="mt-3 h-4 w-full" />
                    <Skeleton className="mt-2 h-4 w-2/3" />
                  </div>
                ) : null}
              </div>
            )}

            {/* The commit box is pinned rather than scrolled to. It is the one
                action the screen exists for, and a message field that walks
                off the bottom of a list is a field nobody finds. */}
            {status ? (
              <div className="shrink-0 border-t px-2 py-2">
                <CommitBox
                  rootDir={rootDir}
                  stagedCount={stagedCount}
                  committing={committing}
                  actions={actions}
                />
              </div>
            ) : null}
          </>
        )}
      </motion.div>

      <ResponsiveDetailSheet
        open={diffOpen && Boolean(selectedPath)}
        onOpenChange={setDiffOpen}
        title={selectedPath ?? t("title")}
      >
        {/* The drawer caps itself at 85vh and `DiffPane` is `h-full` with its
            own scroller, so a bounded box between the two gives that scroller
            something definite to resolve against. `dvh`, so the box follows
            the browser chrome collapsing instead of running under it. */}
        <div className="h-[68dvh] min-h-0">
          {selectedPath && conflict ? (
            <ConflictResolver
              conflict={conflict}
              density="touch"
              onResolve={
                can("git_resolve_conflict")
                  ? (resolution) => {
                      void actions.resolveConflict(conflict.path, resolution).then((failure) => {
                        if (failure) return
                        setDiffOpen(false)
                        selectFile(null, false)
                      })
                    }
                  : undefined
              }
            />
          ) : selectedPath ? (
            <DiffPane
              rootDir={rootDir}
              path={selectedPath}
              staged={selectedStaged}
              actions={actions}
              density="touch"
            />
          ) : null}
        </div>
      </ResponsiveDetailSheet>

      {/* A pick closes the full-screen timeline and opens the commit in a
          drawer, so the detail is never rendered behind a modal overlay. */}
      <TimelineView
        open={timelineOpen}
        onOpenChange={setTimelineOpen}
        rootDir={rootDir}
        filePath={historyPath}
        allowGraph={false}
        onPickCommit={() => {
          setTimelineOpen(false)
          setCommitOpen(true)
        }}
      />
      <ResponsiveDetailSheet
        open={commitOpen && pickedCommit !== null}
        onOpenChange={(open) => {
          setCommitOpen(open)
          if (!open) selectCommit(null)
        }}
        title={pickedCommit?.summary || pickedCommit?.shortHash || t("timeline.title")}
        description={pickedCommit?.shortHash}
      >
        <div className="h-[68dvh] min-h-0" data-testid="sc-mobile-commit">
          {pickedCommit ? (
            <CommitDetail rootDir={rootDir} commit={pickedCommit} actions={actions} />
          ) : null}
        </div>
      </ResponsiveDetailSheet>
      <StashPanel
        open={stashOpen}
        onOpenChange={setStashOpen}
        stashes={stashes}
        actions={actions}
      />
    </div>
  )
}
