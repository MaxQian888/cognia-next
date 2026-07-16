"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { GitCompareArrowsIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { ChatSession } from "@cognia/agent-config-types"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ProjectEditorTabs } from "@/components/editor/project/project-editor-tabs"
import { ProjectRootSwitcher } from "@/components/editor/project/project-root-switcher"
import {
  ProjectEditorFileWorkbench,
  useProjectEditorWorkbench,
} from "@/components/editor/project/project-editor-workbench"
import { ChangesView } from "@/components/source-control/changes-view"
import { DiffPane } from "@/components/source-control/diff-pane"
import { useClientLiveQuery } from "@/hooks/data"
import { useGitActions } from "@/hooks/git/use-git-actions"
import { getSession } from "@/lib/db/sessions"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { refreshGitStatus } from "@/lib/git/load"
import { resolveSessionProjectRoot } from "@/lib/workspace/roots"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useGitStore } from "@/stores/git/git-store"
import { useProjectStore } from "@/stores/project/project-store"

interface DockWorkspaceProps {
  activeSessionId: string | null
}

function WorkspaceEmpty({
  testId,
  title,
  description,
}: {
  testId: string
  title: string
  description: string
}) {
  return (
    <Empty className="h-full border-0" data-testid={testId}>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

export function DockWorkspace({ activeSessionId }: DockWorkspaceProps) {
  const t = useTranslations("artifacts.workspace")
  const request = useArtifactDockLayoutStore((state) => state.workspaceRevealRequest)
  const workspaceContext = useArtifactDockLayoutStore((state) => state.workspaceContext)
  const clearWorkspaceContext = useArtifactDockLayoutStore((state) => state.clearWorkspaceContext)
  const previousActiveSessionId = useRef(activeSessionId)

  useEffect(() => {
    if (previousActiveSessionId.current !== activeSessionId) {
      previousActiveSessionId.current = activeSessionId
      if (!request) clearWorkspaceContext()
    }
  }, [activeSessionId, request, clearWorkspaceContext])

  const session = useClientLiveQuery<ChatSession | undefined>(
    () => (activeSessionId ? getSession(activeSessionId) : Promise.resolve(undefined)),
    [activeSessionId],
    undefined
  )
  const projects = useProjectStore((state) => state.projects)

  if (!hasWorkspaceFsBackend()) {
    return (
      <WorkspaceEmpty
        testId="workspace-unavailable"
        title={t("unavailable.title")}
        description={t("unavailable.description")}
      />
    )
  }

  const revealContext = request ?? workspaceContext
  if (revealContext) {
    return (
      <WorkspaceEditorBody
        key={`${revealContext.sessionId}:${revealContext.rootPath}`}
        sessionId={revealContext.sessionId}
        workingDir={revealContext.rootPath}
      />
    )
  }

  if (!activeSessionId || !session) {
    return (
      <WorkspaceEmpty
        testId="workspace-session-missing"
        title={t("missingSession.title")}
        description={t("missingSession.description")}
      />
    )
  }

  const { project, root } = resolveSessionProjectRoot(session, projects)
  if (!project) {
    return (
      <WorkspaceEmpty
        testId="workspace-project-missing"
        title={t("missingProject.title")}
        description={t("missingProject.description")}
      />
    )
  }

  if (!root) {
    return (
      <WorkspaceEmpty
        testId="workspace-root-missing"
        title={t("missingRoot.title")}
        description={t("missingRoot.description")}
      />
    )
  }

  return <WorkspaceEditorBody sessionId={session.id} workingDir={root.path} />
}

function WorkspaceEditorBody({ sessionId, workingDir }: { sessionId: string; workingDir: string }) {
  const t = useTranslations("artifacts.workspace")
  const request = useArtifactDockLayoutStore((state) => state.workspaceRevealRequest)
  const clearRequest = useArtifactDockLayoutStore((state) => state.clearWorkspaceRevealRequest)
  const [surface, setSurface] = useState<"file" | "review">("file")
  const processedRequest = useRef<string | null>(null)
  const showFileSurface = useCallback(() => setSurface("file"), [])
  const workbench = useProjectEditorWorkbench({
    scopeKey: `session:${sessionId}`,
    workingDir,
    beforeOpen: showFileSurface,
  })
  const editor = workbench.editor
  const {
    roots,
    rootKey,
    rootPath,
    openFiles,
    activePath,
    dirtyCount,
    selectRoot,
    openFile,
    closeFile,
    setActivePath,
  } = editor

  const gitRootDir = useGitStore((state) => state.rootDir)
  const repoState = useGitStore((state) => state.repoState)
  const status = useGitStore((state) => state.status)
  const selectedPath = useGitStore((state) => state.selectedPath)
  const selectedStaged = useGitStore((state) => state.selectedStaged)
  const selectFile = useGitStore((state) => state.selectFile)
  const committing = useGitStore((state) => state.ops.commit)
  const hasReview = gitRootDir === rootPath && repoState?.isRepo === true
  const refresh = useCallback(() => refreshGitStatus(rootPath), [rootPath])
  const gitActions = useGitActions(refresh)

  useEffect(() => {
    if (!request || request.id === processedRequest.current) return
    if (request.sessionId !== sessionId || request.rootPath !== workingDir) return
    if (rootPath !== workingDir) {
      selectRoot(workingDir)
      return
    }
    processedRequest.current = request.id
    if (request.kind === "review") {
      queueMicrotask(() => {
        if (processedRequest.current === request.id) {
          setSurface(hasReview ? "review" : "file")
        }
        clearRequest(request.id)
      })
      return
    }
    void openFile(request.relPath).finally(() => {
      if (processedRequest.current === request.id) setSurface("file")
      clearRequest(request.id)
    })
  }, [request, sessionId, workingDir, rootPath, selectRoot, hasReview, openFile, clearRequest])

  const visibleSurface = hasReview ? surface : "file"

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="dock-workspace"
      onKeyDown={workbench.onKeyDown}
    >
      <div className="flex shrink-0 items-center border-b px-2 py-1">
        <ProjectRootSwitcher roots={roots} rootKey={rootKey} onSelect={selectRoot} />
      </div>
      <ProjectEditorTabs
        fixedTabs={
          hasReview
            ? [
                {
                  id: "review",
                  label: t("review"),
                  icon: <GitCompareArrowsIcon className="size-3.5" />,
                  active: visibleSurface === "review",
                  onSelect: () => setSurface("review"),
                },
              ]
            : undefined
        }
        files={openFiles}
        activePath={visibleSurface === "file" ? activePath : null}
        dirtyCount={dirtyCount}
        onSelect={(path) => {
          setSurface("file")
          setActivePath(path)
        }}
        onClose={closeFile}
        onSaveAll={workbench.saveAll}
      />

      {visibleSurface === "review" && hasReview ? (
        <div className="min-h-0 flex-1" data-testid="workspace-review-layout">
          {status ? (
            <ResizablePanelGroup orientation="horizontal" className="h-full">
              <ResizablePanel id="workspace-review-changes" defaultSize="38%" minSize="25%">
                <ChangesView
                  variant="review"
                  rootDir={rootPath}
                  actions={gitActions}
                  status={status}
                  committing={committing}
                  selectedPath={selectedPath}
                  onSelectFile={selectFile}
                />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="workspace-review-diff" defaultSize="62%" minSize="35%">
                {selectedPath ? (
                  <DiffPane
                    rootDir={rootPath}
                    path={selectedPath}
                    staged={selectedStaged}
                    actions={gitActions}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {t("reviewEmpty")}
                  </div>
                )}
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("reviewEmpty")}
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1" data-testid="workspace-file-layout">
          <ProjectEditorFileWorkbench
            workbench={workbench}
            sidebarPosition="right"
            panelIdPrefix="workspace"
          />
        </div>
      )}
    </div>
  )
}
