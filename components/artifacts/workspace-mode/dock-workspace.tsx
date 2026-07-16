"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FilesIcon, GitCompareArrowsIcon, SearchIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { ChatSession } from "@cognia/agent-config-types"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ProjectEditorTabs } from "@/components/editor/project/project-editor-tabs"
import { ProjectFileTree } from "@/components/editor/project/project-file-tree"
import { ProjectMonaco } from "@/components/editor/project/project-monaco"
import { ProjectRootSwitcher } from "@/components/editor/project/project-root-switcher"
import { ProjectSearchPanel } from "@/components/editor/project/project-search-panel"
import { PROJECT_EDITOR_GOTO_EVENT } from "@/components/editor/project/editor-events"
import { useProjectEditor } from "@/components/editor/project/use-project-editor"
import { ChangesView } from "@/components/source-control/changes-view"
import { DiffPane } from "@/components/source-control/diff-pane"
import { useClientLiveQuery } from "@/hooks/data"
import { useGitActions } from "@/hooks/git/use-git-actions"
import { getSession } from "@/lib/db/sessions"
import type { EditorActionDef } from "@/lib/editor-workbench/register-editor-actions"
import { registerProjectEditorOpener } from "@/lib/files/project-editor-bridge"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { refreshGitStatus } from "@/lib/git/load"
import { primaryRootOf } from "@/lib/workspace/roots"
import { cn } from "@/lib/utils"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useKeybindingStore } from "@/stores/canvas/keybinding-store"
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

  const project = session.projectId
    ? projects.find((candidate) => candidate.id === session.projectId)
    : undefined
  if (!project) {
    return (
      <WorkspaceEmpty
        testId="workspace-project-missing"
        title={t("missingProject.title")}
        description={t("missingProject.description")}
      />
    )
  }

  const root = primaryRootOf(project)
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
  const tEditor = useTranslations("projectEditor")
  const bindings = useKeybindingStore((state) => state.bindings)
  const request = useArtifactDockLayoutStore((state) => state.workspaceRevealRequest)
  const clearRequest = useArtifactDockLayoutStore((state) => state.clearWorkspaceRevealRequest)
  const [surface, setSurface] = useState<"file" | "review">("file")
  const [sideTab, setSideTab] = useState<"files" | "search">("files")
  const processedRequest = useRef<string | null>(null)
  const editor = useProjectEditor({ scopeKey: `session:${sessionId}`, workingDir })
  const {
    roots,
    rootKey,
    rootPath,
    openFiles,
    activePath,
    activeFile,
    dirtyCount,
    treeRefreshToken,
    selectRoot,
    openFile,
    closeFile,
    setActivePath,
    setDraft,
    saveFile,
    saveAll,
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

  const gotoLine = useCallback(
    (relPath: string, line?: number, column?: number) => {
      setSurface("file")
      void openFile(relPath).then(() => {
        if (line === undefined) return
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent(PROJECT_EDITOR_GOTO_EVENT, {
              detail: { relPath, line, column: column ?? 1 },
            })
          )
        }, 0)
      })
    },
    [openFile]
  )

  useEffect(() => {
    return registerProjectEditorOpener({
      root: rootPath,
      open: (relPath, line, column) => gotoLine(relPath, line, column),
    })
  }, [gotoLine, rootPath])

  useEffect(() => {
    if (!request || request.id === processedRequest.current) return
    if (request.sessionId !== sessionId || request.rootPath !== workingDir) return
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
  }, [request, sessionId, workingDir, hasReview, openFile, clearRequest])

  const visibleSurface = hasReview ? surface : "file"

  const handleSaveActive = useCallback(() => {
    if (!activePath) return
    void saveFile(activePath).catch((error) =>
      toast.error(tEditor("saveFailed", { error: String(error) }))
    )
  }, [activePath, saveFile, tEditor])

  const handleSaveAll = useCallback(() => {
    void saveAll().catch((error) => toast.error(tEditor("saveFailed", { error: String(error) })))
  }, [saveAll, tEditor])

  const actionLabels = useMemo<Record<string, string>>(
    () => ({
      "file.save": tEditor("action.save"),
      "file.format": tEditor("action.format"),
      "file.copyPath": tEditor("action.copyPath"),
      "file.copyRelativePath": tEditor("action.copyRelativePath"),
      "file.searchProject": tEditor("action.searchProject"),
    }),
    [tEditor]
  )

  const actions = useMemo<EditorActionDef[]>(
    () => [
      {
        id: "file.save",
        label: "Save",
        contextMenuGroupId: "1_modification",
        alwaysAvailable: true,
        run: handleSaveActive,
      },
      {
        id: "file.format",
        label: "Format Document",
        monacoCommand: "editor.action.formatDocument",
        contextMenuGroupId: "1_modification",
        alwaysAvailable: true,
      },
      {
        id: "file.copyPath",
        label: "Copy Path",
        contextMenuGroupId: "9_cutcopypaste",
        alwaysAvailable: true,
        run: () => {
          if (activeFile) void navigator.clipboard?.writeText(activeFile.absolutePath)
        },
      },
      {
        id: "file.copyRelativePath",
        label: "Copy Relative Path",
        contextMenuGroupId: "9_cutcopypaste",
        alwaysAvailable: true,
        run: () => {
          if (activeFile) void navigator.clipboard?.writeText(activeFile.relPath)
        },
      },
      {
        id: "file.searchProject",
        label: "Search in Project",
        contextMenuGroupId: "z_search",
        alwaysAvailable: true,
        run: () => setSideTab("search"),
      },
    ],
    [activeFile, handleSaveActive]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return
      event.preventDefault()
      if (event.shiftKey) handleSaveAll()
      else handleSaveActive()
    },
    [handleSaveActive, handleSaveAll]
  )

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="dock-workspace"
      onKeyDown={onKeyDown}
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
        onSaveAll={handleSaveAll}
      />

      {visibleSurface === "review" && hasReview && status ? (
        <div className="min-h-0 flex-1" data-testid="workspace-review-layout">
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
        </div>
      ) : (
        <div className="min-h-0 flex-1" data-testid="workspace-file-layout">
          <ResizablePanelGroup orientation="horizontal" className="h-full">
            <ResizablePanel id="workspace-editor" defaultSize="72%" minSize="40%">
              {activeFile ? (
                <ProjectMonaco
                  key={activeFile.absolutePath}
                  file={activeFile}
                  projectRoot={rootPath}
                  onChange={(value) => setDraft(activeFile.relPath, value)}
                  actions={actions}
                  actionLabels={actionLabels}
                  bindings={bindings}
                />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  {tEditor("emptyEditor")}
                </div>
              )}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel id="workspace-sidebar" defaultSize="28%" minSize="18%">
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex shrink-0 border-b">
                  <button
                    type="button"
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1 py-1 text-xs",
                      sideTab === "files" ? "bg-accent" : "text-muted-foreground hover:bg-accent/50"
                    )}
                    onClick={() => setSideTab("files")}
                  >
                    <FilesIcon className="size-3.5" />
                    {tEditor("filesTab")}
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1 py-1 text-xs",
                      sideTab === "search"
                        ? "bg-accent"
                        : "text-muted-foreground hover:bg-accent/50"
                    )}
                    onClick={() => setSideTab("search")}
                  >
                    <SearchIcon className="size-3.5" />
                    {tEditor("searchTab")}
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  {sideTab === "files" ? (
                    <ProjectFileTree
                      rootPath={rootPath}
                      refreshToken={treeRefreshToken}
                      activePath={activePath}
                      onOpenFile={(path) => gotoLine(path)}
                      deps={editor.deps}
                    />
                  ) : (
                    <ProjectSearchPanel rootPath={rootPath} onOpenMatch={gotoLine} />
                  )}
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}
    </div>
  )
}
