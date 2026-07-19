"use client"

/**
 * Source Control panel shell. Desktop-only; binds to the active repo, lays out
 * the changes view next to the diff/conflict/commit-detail pane, and hosts the
 * stash + timeline sheets. Mirrors the perf dashboard's desktop-only early
 * return and reuses the shared resizable split.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { FolderOpenIcon, GitBranchIcon, SlidersHorizontalIcon, SparklesIcon } from "lucide-react"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useResizableLayout } from "@/hooks/ui/use-resizable-layout"
import { gitInit } from "@/lib/git/commands"
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
import { RootSwitcher } from "./root-switcher"
import { StashPanel } from "./stash-panel"
import { SyncToolbar } from "./sync-toolbar"
import { TagPanel } from "./tag-panel"
import { TimelineView } from "./timeline-view"
import { SourceControlViewSettings } from "./view-settings"
import { WorktreePanel } from "./worktree-panel"

export function SourceControlPanel() {
  const t = useTranslations("sourceControl")
  const { available, rootDir, refresh, openFolder } = useGitRepo()
  const actions = useGitActions(refresh)
  const { isDefault: prefsIsDefault } = useSourceControlPrefs()

  const repoState = useGitStore((s) => s.repoState)
  const status = useGitStore((s) => s.status)
  const branches = useGitStore((s) => s.branches)
  const stashes = useGitStore((s) => s.stashes)
  const conflicts = useGitStore((s) => s.conflicts)
  const selectedPath = useGitStore((s) => s.selectedPath)
  const selectedStaged = useGitStore((s) => s.selectedStaged)
  const selectedCommit = useGitStore((s) => s.selectedCommit)
  const selectFile = useGitStore((s) => s.selectFile)
  const selectCommit = useGitStore((s) => s.selectCommit)
  const committing = useGitStore((s) => s.ops.commit)

  const [stashOpen, setStashOpen] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [worktreesOpen, setWorktreesOpen] = useState(false)
  const [blameTarget, setBlameTarget] = useState<{ path: string; rev?: string } | null>(null)
  const [restorePath, setRestorePath] = useState<string | null>(null)
  const [rebaseBase, setRebaseBase] = useState<string | null>(null)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [timelineFile, setTimelineFile] = useState<string | null>(null)
  const layout = useResizableLayout("cognia-git-panel")

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
    return (
      <Empty className="h-full border-0" data-testid="sc-open-folder">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderOpenIcon />
          </EmptyMedia>
          <EmptyTitle>{t("emptyState.noFolder")}</EmptyTitle>
        </EmptyHeader>
        <Button onClick={() => void openFolder()} data-testid="open-folder-button">
          {t("emptyState.openFolder")}
        </Button>
      </Empty>
    )
  }

  if (repoState && !repoState.isRepo) {
    return (
      <Empty className="h-full border-0" data-testid="sc-not-a-repo">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranchIcon />
          </EmptyMedia>
          <EmptyDescription>{t("emptyState.notARepo")}</EmptyDescription>
        </EmptyHeader>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              // Direct call (not via actions.run): rootDir is bound but not a
              // repo yet; refresh flips the panel once init lands.
              void gitInit(rootDir).then(() => refresh())
            }}
            data-testid="init-repo-button"
          >
            <SparklesIcon className="size-3.5" />
            {t("emptyState.initRepo")}
          </Button>
          <Button
            variant="outline"
            onClick={() => void openFolder()}
            data-testid="open-folder-button"
          >
            {t("emptyState.openFolder")}
          </Button>
        </div>
      </Empty>
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
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-2">
        <div className="flex min-w-0 items-center gap-1">
          <RootSwitcher />
          <BranchHeader
            branch={status?.branch ?? null}
            ahead={status?.ahead ?? 0}
            behind={status?.behind ?? 0}
            branches={branches}
            actions={actions}
          />
        </div>
        <div className="flex items-center gap-0.5">
          <SyncToolbar
            actions={actions}
            onOpenStash={() => setStashOpen(true)}
            onOpenTimeline={() => openTimelineFor(null)}
            onOpenRemotes={() => setRemoteOpen(true)}
            onOpenTags={() => setTagOpen(true)}
            onOpenCompare={() => setCompareOpen(true)}
            onOpenWorktrees={() => setWorktreesOpen(true)}
            onRefresh={() => void refresh()}
          />
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
                  <span
                    className="absolute right-1 top-1 size-1.5 rounded-full bg-blue-500"
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
      </header>

      {repoState?.operationInProgress && (
        <div
          className="flex items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs"
          data-testid="sequencer-banner"
        >
          <span className="min-w-0 flex-1 truncate text-amber-700 dark:text-amber-400">
            {t(`sequencer.inProgress.${repoState.operationInProgress}` as never)}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-xs"
            onClick={() => void actions.sequencerContinue()}
            data-testid="sequencer-continue"
          >
            {t("sequencer.continue")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-xs text-destructive"
            onClick={() => void actions.sequencerAbort()}
            data-testid="sequencer-abort"
          >
            {t("sequencer.abort")}
          </Button>
        </div>
      )}

      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="min-h-0 flex-1"
      >
        <ResizablePanel id="sc-changes" defaultSize="32%" minSize="20%">
          {status ? (
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
          ) : null}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="sc-diff" defaultSize="68%" minSize="30%">
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
              onResolve={(resolution) => {
                void actions.resolveConflict(conflict.path, resolution)
                selectFile(null, false)
              }}
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
      <WorktreePanel open={worktreesOpen} onOpenChange={setWorktreesOpen} rootDir={rootDir} />
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
        <SheetContent side="right" className="flex w-[40rem] flex-col" data-testid="blame-sheet">
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
