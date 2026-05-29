"use client"

/**
 * Source Control panel shell. Desktop-only; binds to the active repo, lays out
 * the changes view next to the diff/conflict/commit-detail pane, and hosts the
 * stash + timeline sheets. Mirrors the perf dashboard's desktop-only early
 * return and reuses the shared resizable split.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { FolderOpenIcon, GitBranchIcon } from "lucide-react"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useResizableLayout } from "@/hooks/ui/use-resizable-layout"
import { useGitRepo } from "@/hooks/git/use-git-repo"
import { useGitActions } from "@/hooks/git/use-git-actions"
import { useGitStore } from "@/stores/git/git-store"
import { BranchHeader } from "./branch-header"
import { ChangesView } from "./changes-view"
import { CommitDetail } from "./commit-detail"
import { ConflictResolver } from "./conflict-resolver"
import { DiffPane } from "./diff-pane"
import { StashPanel } from "./stash-panel"
import { SyncToolbar } from "./sync-toolbar"
import { TimelineView } from "./timeline-view"

export function SourceControlPanel() {
  const t = useTranslations("sourceControl")
  const { available, rootDir, refresh, openFolder } = useGitRepo()
  const actions = useGitActions(refresh)

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
        <Button
          variant="outline"
          onClick={() => void openFolder()}
          data-testid="open-folder-button"
        >
          {t("emptyState.openFolder")}
        </Button>
      </Empty>
    )
  }

  const conflict = selectedPath ? conflicts.find((c) => c.path === selectedPath) : undefined

  const openTimelineFor = (path: string | null) => {
    setTimelineFile(path)
    setTimelineOpen(true)
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="source-control-panel">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-2">
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
          onRefresh={() => void refresh()}
        />
      </header>

      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="min-h-0 flex-1"
      >
        <ResizablePanel id="sc-changes" defaultSize={32} minSize={20}>
          {status ? (
            <ChangesView
              rootDir={rootDir}
              status={status}
              actions={actions}
              committing={committing}
              selectedPath={selectedPath}
              onSelectFile={(path, staged) => selectFile(path, staged)}
              onViewHistory={(path) => openTimelineFor(path)}
            />
          ) : null}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="sc-diff" defaultSize={68} minSize={30}>
          {selectedCommit ? (
            <CommitDetail rootDir={rootDir} commit={syntheticCommit(selectedCommit)} />
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
