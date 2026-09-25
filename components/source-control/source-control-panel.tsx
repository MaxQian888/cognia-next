"use client"

/**
 * Source Control panel shell. Desktop-only; binds to the active repo, lays out
 * the changes view next to the diff/conflict/commit-detail pane, and hosts the
 * stash + timeline sheets. Mirrors the perf dashboard's desktop-only early
 * return and reuses the shared resizable split.
 */

import { useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { LayoutGroup, motion } from "motion/react"
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  DownloadIcon,
  FileSearchIcon,
  FolderOpenIcon,
  GitBranchIcon,
  RefreshCwIcon,
  ScanSearchIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
} from "lucide-react"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useResizableLayout } from "@/hooks/ui/use-resizable-layout"
import { useDeferredLoading } from "@/hooks/ui/use-deferred-loading"
import { useElementWidth } from "@/hooks/use-element-width"
import { MOBILE_SPRING, mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import { commitShell } from "@/lib/git/commit-shell"
import { parseGitTarget } from "@/lib/git/target"
import { openPathAsWorkspace } from "@/lib/workspace/open-folder"
import { useGitRepo } from "@/hooks/git/use-git-repo"
import { useGitActions } from "@/hooks/git/use-git-actions"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"
import { useGitStore } from "@/stores/git/git-store"
import { BranchHeader } from "./branch-header"
import { ChangesView } from "./changes-view"
import { CommitDetail } from "./commit-detail"
import { CompareRefsSheet } from "./compare-refs-sheet"
import { ConflictResolver } from "./conflict-resolver"
import { BlameView } from "./blame-view"
import { DiffPane } from "./diff-pane"
import { InteractiveRebaseDialog } from "./interactive-rebase-dialog"
import { RemotePanel } from "./remote-panel"
import { RestoreDialog } from "./restore-dialog"
import { PanelRootChip } from "@/components/workspace/panel-root-chip"
import { useGitBranchIndicator } from "@/hooks/git/use-git-branch-indicator"
import { RootSwitcher } from "./root-switcher"
import { RepositoryNavigator } from "./repository-navigator"
import { StackPanel } from "./stack-panel"
import { StashPanel } from "./stash-panel"
import { SequencerBanner, StaleStatusBanner } from "./status-banners"
import { SyncToolbar } from "./sync-toolbar"
import { TagPanel } from "./tag-panel"
import { TimelineView } from "./timeline-view"
import { SourceControlViewSettings } from "./view-settings"
import { WorktreePanel } from "./worktree-panel"
import { CloneRepositoryDialog } from "./clone-repository-dialog"
import { UnifiedReviewSheet } from "./unified-review-sheet"
import { useProjectStore } from "@/stores/project/project-store"
import { allRootPaths } from "@/lib/workspace/roots"
import { useChatStore } from "@/stores/chat"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"

/**
 * Below this PANE width the panel stacks its two columns instead of splitting
 * them side by side, and its header collapses the root controls behind a
 * popover.
 *
 * A pane width, not a viewport width, and the distinction is the point. The
 * compact tier (`useCompactLayout`, 768px) asks "is this a phone-shaped
 * SCREEN", and `app/source-control/page.tsx` uses it to choose which body to
 * mount at all. This one asks "does this PANE have room for two columns",
 * which has a different answer wherever the panel is not the whole window.
 */
export const SOURCE_CONTROL_DENSE_WIDTH = 960

/** Which body the panel is showing. */
export type SourceControlView = "changes" | "browse"

export const SOURCE_CONTROL_VIEWS: readonly SourceControlView[] = ["changes", "browse"]

export function SourceControlPanel() {
  const t = useTranslations("sourceControl")
  const tReview = useTranslations("unifiedReview")
  const {
    available,
    rootDir,
    refresh,
    openFolder,
    remoteWorkspaces,
    selectRemoteWorkspace,
    remote,
  } = useGitRepo()
  // Observe only: `useGitBranchIndicator` is always mounted elsewhere and owns
  // the native controller. This reads its resolved target for the header chip.
  const indicator = useGitBranchIndicator({ enabled: false })
  const actions = useGitActions(refresh)
  const can = actions.can ?? (() => true)
  const { isDefault: prefsIsDefault } = useSourceControlPrefs()

  const repoState = useGitStore((s) => s.repoState)
  const status = useGitStore((s) => s.status)
  const loadingStatus = useGitStore((s) => s.loadingStatus)
  const loadError = useGitStore((s) => s.loadError)
  const branches = useGitStore((s) => s.branches)
  const stashes = useGitStore((s) => s.stashes)
  const conflicts = useGitStore((s) => s.conflicts)
  const selectedPath = useGitStore((s) => s.selectedPath)
  const selectedStaged = useGitStore((s) => s.selectedStaged)
  const selectedCommit = useGitStore((s) => s.selectedCommit)
  // The loaded histories, which give a picked commit its header.
  const repoHistory = useGitStore((s) => s.timelineRepo)
  const fileHistory = useGitStore((s) => s.timelineFile)
  const selectFile = useGitStore((s) => s.selectFile)
  const selectCommit = useGitStore((s) => s.selectCommit)
  const committing = useGitStore((s) => s.ops.commit)
  const initializing = useGitStore((s) => s.ops.init)
  const activeProject = useProjectStore((state) =>
    state.activeProjectId
      ? state.projects.find((project) => project.id === state.activeProjectId)
      : undefined
  )
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const activeTaskRun = useTaskWorkspaceStore((state) =>
    activeSessionId ? state.activeBySession[activeSessionId] : undefined
  )

  const [cloneOpen, setCloneOpen] = useState(false)
  const [stashOpen, setStashOpen] = useState(false)
  const [stacksOpen, setStacksOpen] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [worktreesOpen, setWorktreesOpen] = useState(false)
  const [blameTarget, setBlameTarget] = useState<{ path: string; rev?: string } | null>(null)
  const [restorePath, setRestorePath] = useState<string | null>(null)
  const [rebaseBase, setRebaseBase] = useState<string | null>(null)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [timelineFile, setTimelineFile] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  // Measured, not queried. `useMediaQuery` asked how wide the WINDOW is and
  // answered for the PANE, which is a different number wherever this panel is
  // not the whole screen: nested in a workspace tab it got a side-by-side
  // split it had no room for at a 1000px window. `useElementWidth` measures in
  // a layout effect before paint, so the first frame already has the right
  // layout. `0` means "not measured yet", so it must not read as narrow.
  // Which body: the change list and its diff, or the repository navigator.
  // Local state rather than a route param, because the two views share every
  // read and a URL that named one would have to be kept in step with the
  // panel's four other mounts.
  const [view, setView] = useState<SourceControlView>("changes")
  const panelRef = useRef<HTMLDivElement>(null)
  const paneWidth = useElementWidth(panelRef)
  const isNarrow = paneWidth > 0 && paneWidth < SOURCE_CONTROL_DENSE_WIDTH
  const layout = useResizableLayout(
    isNarrow ? "cognia-git-panel-vertical" : "cognia-git-panel-horizontal"
  )
  // The first status read, skeleton-first. Deferred so a warm read (the usual
  // case: the status-bar controller already loaded this repository) never
  // flashes one. Called before the early returns below, like every hook.
  const skeletonVisible = useDeferredLoading(!status && loadingStatus, { key: rootDir })
  const tabPillGroup = useId()
  const tabPill = useReducedMotionTransition(MOBILE_SPRING)
  const fade = useReducedMotionTransition(mobileTransition("fast"))
  const refreshSafely = () => void refresh().catch(() => undefined)
  const selectedRemoteTarget = rootDir ? parseGitTarget(rootDir) : null
  const cloneDialog = (
    <CloneRepositoryDialog
      open={cloneOpen}
      onOpenChange={setCloneOpen}
      onCloned={remote ? (path) => useGitStore.getState().setRootDir(path) : openPathAsWorkspace}
      remoteWorkspaceId={
        selectedRemoteTarget?.kind === "remote" ? selectedRemoteTarget.workspaceId : undefined
      }
      available={can("git_clone")}
    />
  )

  if (!available) {
    return (
      <Empty className="h-full border-0" data-testid="sc-desktop-only">
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
    if (remote) {
      return (
        <Empty className="h-full border-0" data-testid="sc-no-remote-workspace">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpenIcon />
            </EmptyMedia>
            <EmptyTitle>{t("remote.noWorkspace")}</EmptyTitle>
            <EmptyDescription>{t("remote.noWorkspaceDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )
    }
    return (
      <>
        <Empty className="h-full border-0" data-testid="sc-open-folder">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpenIcon />
            </EmptyMedia>
            <EmptyTitle>{t("emptyState.noFolder")}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent className="flex-row gap-2">
            <Button onClick={() => void openFolder()} data-testid="open-folder-button">
              {t("emptyState.openFolder")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setCloneOpen(true)}
              disabled={!can("git_clone")}
              data-testid="clone-repo-button"
            >
              <DownloadIcon className="size-3.5" />
              {t("clone.open")}
            </Button>
          </EmptyContent>
        </Empty>
        {cloneDialog}
      </>
    )
  }

  if (repoState && !repoState.isRepo) {
    return (
      <>
        <Empty className="h-full border-0" data-testid="sc-not-a-repo">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitBranchIcon />
            </EmptyMedia>
            <EmptyDescription>{t("emptyState.notARepo")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row gap-2">
            <Button
              // Through the action runner: a failed init toasts instead of
              // vanishing, and a successful one refreshes the panel onto the
              // repository it just created.
              onClick={() => void actions.init()}
              disabled={initializing || !can("git_init")}
              data-testid="init-repo-button"
            >
              <SparklesIcon className="size-3.5" />
              {t("emptyState.initRepo")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setCloneOpen(true)}
              disabled={!can("git_clone")}
              data-testid="clone-repo-button"
            >
              <DownloadIcon className="size-3.5" />
              {t("clone.open")}
            </Button>
            {!remote && (
              <Button
                variant="outline"
                onClick={() => void openFolder()}
                data-testid="open-folder-button"
              >
                {t("emptyState.openFolder")}
              </Button>
            )}
          </EmptyContent>
        </Empty>
        {cloneDialog}
      </>
    )
  }

  const conflict = selectedPath ? conflicts.find((c) => c.path === selectedPath) : undefined
  const rightPaneKind = selectedCommit
    ? "commit"
    : conflict
      ? "conflict"
      : selectedPath
        ? "diff"
        : "empty"

  const openTimelineFor = (path: string | null) => {
    setTimelineFile(path)
    setTimelineOpen(true)
  }

  return (
    <div
      ref={panelRef}
      className="flex h-full min-h-0 flex-col"
      data-bg-target="chat"
      data-dense={isNarrow ? "true" : undefined}
      data-testid="source-control-panel"
    >
      <FeaturePageHeader
        variant="compact"
        icon={<GitBranchIcon />}
        title={t("title")}
        breadcrumb={
          <div className="flex min-w-0 items-center gap-2">
            <RootSwitcher
              remoteWorkspaces={remote ? remoteWorkspaces : undefined}
              onSelectRemoteWorkspace={selectRemoteWorkspace}
            />
            {/* A panel that silently retargets is worse than one that needs a
                click: the user reads a diff believing they know which tree it
                is. Says which folder, whether it is a worktree alias, and
                whether it is following the conversation or pinned. */}
            <PanelRootChip
              panel="sourceControl"
              target={indicator.target}
              onTogglePin={indicator.togglePin}
            />
          </div>
        }
        navigationPlacement="inline"
        navigation={
          // The inline slot, which is `min-w-0 shrink overflow-x-auto`, so a
          // two-tab set can never push the actions past the header's edge.
          <LayoutGroup id={tabPillGroup}>
            <div
              role="tablist"
              aria-label={t("views.label")}
              className="flex items-center gap-0.5"
              data-testid="sc-view-switcher"
            >
              {SOURCE_CONTROL_VIEWS.map((candidate) => (
                <Button
                  key={candidate}
                  type="button"
                  role="tab"
                  aria-selected={view === candidate}
                  variant="ghost"
                  size="sm"
                  onClick={() => setView(candidate)}
                  aria-label={t(`views.${candidate}`)}
                  className={cn(
                    // `isolate`: the pill's `-z-10` stays inside the button
                    // instead of sinking behind the header's background.
                    "relative isolate h-7 gap-1.5 px-2 text-xs",
                    view === candidate && "text-foreground"
                  )}
                  data-testid={`sc-view-${candidate}`}
                >
                  {/* One pill that slides between the tabs (shared layout)
                      instead of a background that blinks from one to the
                      other. Behind the content, so the icon and label sit on
                      it; the group id keeps two mounted panels apart. */}
                  {view === candidate && (
                    <motion.span
                      layoutId="sc-view-pill"
                      transition={tabPill}
                      aria-hidden
                      className="absolute inset-0 -z-10 rounded-md bg-accent"
                      data-testid="sc-view-pill"
                    />
                  )}
                  {candidate === "changes" ? (
                    <FileSearchIcon aria-hidden className="size-3.5" />
                  ) : (
                    <GitBranchIcon aria-hidden className="size-3.5" />
                  )}
                  {/* `@3xl` (768px of HEADER width), not `@xl`. At `@xl` the
                      labels still showed on an 820px window where the row had
                      no room for them, and the slot's own `overflow-x-auto` cut
                      "Browse" off mid-word. Icon-only is the honest fallback,
                      and `aria-label` carries the name either way. */}
                  <span className="hidden @3xl/feature-header:inline">
                    {t(`views.${candidate}`)}
                  </span>
                </Button>
              ))}
            </div>
          </LayoutGroup>
        }
        actions={
          <div className="flex min-w-0 items-center gap-0.5">
            <BranchHeader
              branch={status?.branch ?? null}
              ahead={status?.ahead ?? 0}
              behind={status?.behind ?? 0}
              branches={branches}
              actions={actions}
            />
            <SyncToolbar
              dense={isNarrow}
              actions={actions}
              onOpenStash={() => setStashOpen(true)}
              onOpenTimeline={() => openTimelineFor(null)}
              onOpenRemotes={() => setRemoteOpen(true)}
              onOpenTags={() => setTagOpen(true)}
              onOpenCompare={() => setCompareOpen(true)}
              onOpenWorktrees={() => setWorktreesOpen(true)}
              onOpenStacks={() => setStacksOpen(true)}
              onRefresh={refreshSafely}
            />
            {/* Not `FileSearchIcon`: that is the Changes tab's glyph two
                controls to the left, and one icon for two destinations made
                the review sheet look like a second way into the change list. */}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              aria-label={tReview("open")}
              onClick={() => setReviewOpen(true)}
              data-testid="sc-open-review"
            >
              <ScanSearchIcon className="size-3.5" />
            </Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative size-7 text-muted-foreground hover:text-foreground"
                  aria-label={t("viewSettings.label")}
                  data-testid="sc-view-settings-trigger"
                >
                  <SlidersHorizontalIcon className="size-3.5" />
                  {!prefsIsDefault && (
                    <Badge
                      className="absolute right-1 top-1 size-1.5 rounded-full p-0"
                      aria-hidden
                    />
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72">
                <SourceControlViewSettings />
              </PopoverContent>
            </Popover>
          </div>
        }
      />

      <SequencerBanner operation={repoState?.operationInProgress ?? null} actions={actions} />
      <StaleStatusBanner message={loadError && status ? loadError : null} onRetry={refreshSafely} />

      {!status && loadingStatus ? (
        <div
          role="status"
          aria-label={t("repository.loading")}
          className="min-h-0 flex-1"
          data-testid="sc-loading"
        >
          {skeletonVisible ? <PanelSkeleton narrow={isNarrow} /> : null}
        </div>
      ) : !status && loadError ? (
        <Empty className="min-h-0 flex-1 border-0" data-testid="sc-load-error">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertTriangleIcon />
            </EmptyMedia>
            <EmptyTitle>{t("repository.errorTitle")}</EmptyTitle>
            <EmptyDescription>{loadError}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={refreshSafely} data-testid="sc-load-retry">
              <RefreshCwIcon className="size-3.5" />
              {t("repository.retry")}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        // Keyed by view, so switching tabs fades the new body in instead of
        // swapping it in one frame. Also the height bound the navigator
        // needed: it is an `h-full` scroller, and as a bare flex child it took
        // the WHOLE panel's height and ran its last rows past the bottom edge.
        <motion.div
          key={view}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={fade}
          className="flex min-h-0 flex-1 flex-col"
          data-testid={`sc-view-body-${view}`}
        >
          {view === "browse" ? (
            <RepositoryNavigator
              rootDir={rootDir}
              branches={branches}
              actions={actions}
              canMutate={actions.can}
            />
          ) : (
            <ResizablePanelGroup
              orientation={isNarrow ? "vertical" : "horizontal"}
              defaultLayout={layout.defaultLayout}
              onLayoutChanged={layout.onLayoutChanged}
              className="min-h-0 flex-1"
            >
              <ResizablePanel
                id="sc-changes"
                defaultSize={isNarrow ? "42%" : "32%"}
                minSize={isNarrow ? "28%" : "20%"}
              >
                {status && (
                  <ChangesView
                    rootDir={rootDir}
                    status={status}
                    actions={actions}
                    committing={committing}
                    selectedPath={selectedPath}
                    onSelectFile={(path, staged) => selectFile(path, staged)}
                    onViewHistory={(path) => openTimelineFor(path)}
                    onViewBlame={(path) => setBlameTarget({ path })}
                    onRestore={(path) => setRestorePath(path)}
                  />
                )}
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel
                id="sc-diff"
                defaultSize={isNarrow ? "58%" : "68%"}
                minSize={isNarrow ? "32%" : "30%"}
              >
                {/* Faded in per KIND of content (diff, commit, conflict, empty),
                not per file: re-keying on the path would rebuild the Monaco
                editor on every click in the change list. */}
                <motion.div
                  key={rightPaneKind}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={fade}
                  className="h-full"
                  data-testid={`sc-right-pane-${rightPaneKind}`}
                >
                  {selectedCommit ? (
                    <div className="flex h-full min-h-0 flex-col">
                      {/* The way back. Picking a file in the list also leaves, but
                      with a clean tree, or in the stacked layout where the
                      list is out of sight, there was no way out at all. */}
                      <div className="flex shrink-0 items-center border-b px-2 py-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          className="gap-1 text-muted-foreground"
                          onClick={() => selectCommit(null)}
                          data-testid="sc-commit-back"
                        >
                          <ArrowLeftIcon className="size-3" />
                          {t("commitDetail.backToChanges")}
                        </Button>
                      </div>
                      <div className="min-h-0 flex-1">
                        <CommitDetail
                          rootDir={rootDir}
                          commit={commitShell(selectedCommit, [repoHistory, fileHistory])}
                          actions={actions}
                          onViewBlame={(path, rev) => setBlameTarget({ path, rev })}
                          onInteractiveRebase={(base) => setRebaseBase(base)}
                        />
                      </div>
                    </div>
                  ) : conflict ? (
                    <ConflictResolver
                      conflict={conflict}
                      onResolve={
                        can("git_resolve_conflict")
                          ? (resolution) => {
                              void actions
                                .resolveConflict(conflict.path, resolution)
                                .then((failure) => {
                                  if (!failure) selectFile(null, false)
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
                    />
                  ) : (
                    <DiffPaneEmpty />
                  )}
                </motion.div>
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </motion.div>
      )}

      <StashPanel
        open={stashOpen}
        onOpenChange={setStashOpen}
        stashes={stashes}
        actions={actions}
      />
      <RemotePanel
        open={remoteOpen}
        onOpenChange={setRemoteOpen}
        rootDir={rootDir}
        actions={actions}
      />
      <TagPanel open={tagOpen} onOpenChange={setTagOpen} rootDir={rootDir} actions={actions} />
      <CompareRefsSheet open={compareOpen} onOpenChange={setCompareOpen} rootDir={rootDir} />
      <WorktreePanel
        open={worktreesOpen}
        onOpenChange={setWorktreesOpen}
        rootDir={rootDir}
        canMutate={can}
      />
      <StackPanel
        open={stacksOpen}
        onOpenChange={setStacksOpen}
        rootDir={rootDir}
        branches={branches}
      />
      <RestoreDialog
        rootDir={rootDir}
        path={restorePath}
        onOpenChange={(open) => !open && setRestorePath(null)}
        actions={actions}
      />
      {/* Keyed by repository AND base: the dialog holds the user's edited
          todo list, which must not survive into another repository that
          happens to share the base name ("main"). */}
      <InteractiveRebaseDialog
        key={`${rootDir}\u0000${rebaseBase ?? "none"}`}
        rootDir={rootDir}
        base={rebaseBase}
        onOpenChange={(open) => !open && setRebaseBase(null)}
        actions={actions}
      />
      <Sheet open={blameTarget !== null} onOpenChange={(open) => !open && setBlameTarget(null)}>
        <SheetContent
          side="right"
          className="flex w-full flex-col sm:max-w-2xl"
          data-testid="blame-sheet"
        >
          <SheetHeader>
            <SheetTitle className="truncate">
              {t("blame.title", { path: blameTarget?.path ?? "" })}
            </SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1">
            {blameTarget && (
              <BlameView
                key={`${blameTarget.path}@${blameTarget.rev ?? "wt"}`}
                rootDir={rootDir}
                path={blameTarget.path}
                rev={blameTarget.rev}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
      {/* A pick closes the sheet: the detail renders in the right pane,
          which this modal sheet otherwise covers with its overlay. Closing
          without a pick leaves whatever the pane was showing alone. */}
      <TimelineView
        open={timelineOpen}
        onOpenChange={setTimelineOpen}
        rootDir={rootDir}
        filePath={timelineFile}
        onPickCommit={() => setTimelineOpen(false)}
      />
      <UnifiedReviewSheet
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        rootDir={rootDir}
        repositoryRoots={activeProject ? allRootPaths(activeProject) : [rootDir]}
        stagedCount={status?.staged.length ?? 0}
        committing={committing}
        actions={actions}
        // One entry, for the root the active task run actually wrote in. A
        // last-turn review of any OTHER selected root has no run to read, and
        // the scope collector says so by name instead of silently reviewing
        // this root's patch against a repository it never touched.
        lastTurnRunIdByRoot={
          activeTaskRun ? { [activeTaskRun.workspaceRoot]: activeTaskRun.runId } : undefined
        }
      />
    </div>
  )
}

/**
 * The first-load placeholder, shaped like what replaces it: a change list
 * beside (or, narrow, above) a diff. Decorative; the wrapper carries the
 * `role="status"` and its label.
 */
function PanelSkeleton({ narrow }: { narrow: boolean }) {
  return (
    <div
      aria-hidden
      className={cn("flex h-full min-h-0 gap-px bg-border/40", narrow ? "flex-col" : "flex-row")}
      data-testid="sc-loading-skeleton"
    >
      <div
        className={cn(
          "flex shrink-0 flex-col gap-2 bg-background p-3",
          narrow ? "h-2/5" : "w-[32%]"
        )}
      >
        <Skeleton className="h-16 w-full" />
        <Skeleton className="mt-2 h-3 w-24" />
        {[82, 64, 90, 58, 74].map((width) => (
          <Skeleton key={width} className="h-4" style={{ width: `${width}%` }} />
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 bg-background p-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="min-h-0 w-full flex-1" />
      </div>
    </div>
  )
}

function DiffPaneEmpty() {
  const t = useTranslations("sourceControl")
  return (
    <Empty className="h-full border-0" data-testid="diff-pane-empty">
      <EmptyHeader>
        <EmptyDescription>{t("diff.selectFile")}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
