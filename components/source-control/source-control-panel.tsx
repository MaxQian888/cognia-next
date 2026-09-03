"use client"

/**
 * Source Control panel shell. Desktop-only; binds to the active repo, lays out
 * the changes view next to the diff/conflict/commit-detail pane, and hosts the
 * stash + timeline sheets. Mirrors the perf dashboard's desktop-only early
 * return and reuses the shared resizable split.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  DownloadIcon,
  FileSearchIcon,
  FolderOpenIcon,
  GitBranchIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
} from "lucide-react"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
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
import { useMediaQuery } from "@/hooks/ui/use-media-query"
import { Spinner } from "@/components/ui/spinner"
import { gitInit, runGitUserAction } from "@/lib/git/commands"
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
import { StackPanel } from "./stack-panel"
import { StashPanel } from "./stash-panel"
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
  const selectFile = useGitStore((s) => s.selectFile)
  const selectCommit = useGitStore((s) => s.selectCommit)
  const committing = useGitStore((s) => s.ops.commit)
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
  const isNarrow = useMediaQuery("(max-width: 959.98px)")
  const layout = useResizableLayout(
    isNarrow ? "cognia-git-panel-vertical" : "cognia-git-panel-horizontal"
  )
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
              onClick={() => {
                // Direct call (not via actions.run): rootDir is bound but not a
                // repo yet; refresh flips the panel once init lands.
                void runGitUserAction("git_init", () => gitInit(rootDir)).then(() => refresh())
              }}
              disabled={!can("git_init")}
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

  const openTimelineFor = (path: string | null) => {
    setTimelineFile(path)
    setTimelineOpen(true)
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-bg-target="chat"
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
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              aria-label={tReview("open")}
              onClick={() => setReviewOpen(true)}
            >
              <FileSearchIcon className="size-3.5" />
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

      {repoState?.operationInProgress && (
        <Alert
          className="rounded-none border-x-0 border-t-0 px-3 py-1.5"
          data-testid="sequencer-banner"
        >
          <AlertDescription className="flex min-w-0 items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">
              {t(`sequencer.inProgress.${repoState.operationInProgress}` as never)}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-xs"
              onClick={() => void actions.sequencerContinue()}
              disabled={!can("git_sequencer_continue")}
              data-testid="sequencer-continue"
            >
              {t("sequencer.continue")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs text-destructive"
              onClick={() => void actions.sequencerAbort()}
              disabled={!can("git_sequencer_abort")}
              data-testid="sequencer-abort"
            >
              {t("sequencer.abort")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loadError && status && (
        <Alert
          variant="destructive"
          className="rounded-none border-x-0 border-t-0 px-3 py-1.5"
          data-testid="sc-load-error-banner"
        >
          <AlertTriangleIcon className="size-3.5 shrink-0 text-destructive" />
          <AlertDescription className="flex min-w-0 items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {t("repository.stale", { message: loadError })}
            </span>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={refreshSafely}>
              <RefreshCwIcon className="size-3" />
              {t("repository.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!status && loadingStatus ? (
        <Empty className="min-h-0 flex-1 border-0" data-testid="sc-loading">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>{t("repository.loading")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
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
            {selectedCommit ? (
              <CommitDetail
                rootDir={rootDir}
                commit={syntheticCommit(selectedCommit)}
                actions={actions}
                onViewBlame={(path, rev) => setBlameTarget({ path, rev })}
                onInteractiveRebase={(base) => setRebaseBase(base)}
              />
            ) : conflict ? (
              <ConflictResolver
                conflict={conflict}
                onResolve={
                  can("git_resolve_conflict")
                    ? (resolution) => {
                        void actions.resolveConflict(conflict.path, resolution).then((failure) => {
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
          </ResizablePanel>
        </ResizablePanelGroup>
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
      <InteractiveRebaseDialog
        key={rebaseBase ?? "none"}
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
      <TimelineView
        open={timelineOpen}
        onOpenChange={(open) => {
          setTimelineOpen(open)
          if (!open) selectCommit(null)
        }}
        rootDir={rootDir}
        filePath={timelineFile}
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

/**
 * The Timeline list stores only the selected sha in the store. The
 * CommitDetail component re-fetches the commit's metadata via its file list,
 * but needs a `GitCommit` shell to render the header before data arrives — we
 * look it up from the loaded timeline, falling back to a minimal stub.
 */
function syntheticCommit(hash: string) {
  const { timelineRepo, timelineFile } = useGitStore.getState()
  const found = [...timelineRepo, ...timelineFile].find((c) => c.hash === hash)
  return (
    found ?? {
      hash,
      shortHash: hash.slice(0, 7),
      summary: "",
      body: "",
      authorName: "",
      authorEmail: "",
      authoredAtMs: 0,
      parents: [],
    }
  )
}
