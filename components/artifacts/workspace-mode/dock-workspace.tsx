"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { GitCompareArrowsIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { ChatSession } from "@cognia/agent-config-types"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { CodeServerPane, joinProjectPath } from "@/components/editor/project/code-server-pane"
import { EditorEngineToggle } from "@/components/editor/project/editor-engine-toggle"
import { codeServerClient } from "@/lib/codeserver/client"
import { ProjectEditorTabs } from "@/components/editor/project/project-editor-tabs"
import { ProjectRootSwitcher } from "@/components/editor/project/project-root-switcher"
import {
  ProjectEditorFileWorkbench,
  useProjectEditorWorkbench,
} from "@/components/editor/project/project-editor-workbench"
import { ChangesView } from "@/components/source-control/changes-view"
import { useChatStore } from "@/stores/chat"
import { DiffPane } from "@/components/source-control/diff-pane"
import { useClientLiveQuery } from "@/hooks/data"
import { useGitActions } from "@/hooks/git/use-git-actions"
import { getSession } from "@/lib/db/sessions"
import { useCodeServerSupported } from "@/hooks/codeserver/use-code-server-supported"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { refreshGitStatus } from "@/lib/git/load"
import { isTauri } from "@/lib/tauri"
import { listTaskRuns, listTaskWorkspaces } from "@/lib/task-workspace/client"
import { cn } from "@/lib/utils"
import { resolveSessionProjectRoot } from "@/lib/workspace/roots"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useProjectEditorSessionStore } from "@/stores/editor/project-editor-session-store"
import { useGitStore } from "@/stores/git/git-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import { TaskResourcesPanel } from "./task-resources-panel"

interface DockWorkspaceProps {
  activeSessionId: string | null
  layout?: "desktop" | "mobile"
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

export function DockWorkspace({ activeSessionId, layout = "desktop" }: DockWorkspaceProps) {
  const t = useTranslations("artifacts.workspace")
  const request = useArtifactDockLayoutStore((state) => state.workspaceRevealRequest)
  const workspaceContext = useArtifactDockLayoutStore((state) => state.workspaceContext)

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

  // A reveal deliberately outranks the session's own root — it can name a
  // background or split pane's conversation, and the card that fired it belongs
  // to that conversation. Dropping it once the user navigates elsewhere is
  // therefore a *session-switch* concern, and it lives in
  // `session-focus-initializer`: the ref-based guard that used to sit here
  // could never work, because switching conversations changes the workbench
  // scope key and remounts this component with the ref already holding the new
  // id — so conversation B kept rendering conversation A's file.
  const revealContext = request ?? workspaceContext
  if (revealContext) {
    return (
      <WorkspaceEditorBody
        key={`${revealContext.sessionId}:${revealContext.rootPath}`}
        sessionId={revealContext.sessionId}
        workingDir={revealContext.rootPath}
        layout={layout}
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

  return <WorkspaceEditorBody sessionId={session.id} workingDir={root.path} layout={layout} />
}

function WorkspaceEditorBody({
  sessionId,
  workingDir,
  layout,
}: {
  sessionId: string
  workingDir: string
  layout: "desktop" | "mobile"
}) {
  const t = useTranslations("artifacts.workspace")
  const request = useArtifactDockLayoutStore((state) => state.workspaceRevealRequest)
  const clearRequest = useArtifactDockLayoutStore((state) => state.clearWorkspaceRevealRequest)
  const addContextSelection = useChatStore((state) => state.addContextSelection)
  const [surface, setSurface] = useState<"file" | "review">("file")
  const [scope, setScope] = useState<"task" | "workspace">("task")
  const [mobileReviewPane, setMobileReviewPane] = useState<"changes" | "diff">("changes")
  const processedRequest = useRef<string | null>(null)
  const showFileSurface = useCallback(() => setSurface("file"), [])
  const scopeKey = `session:${sessionId}`

  // Pro IDE (code-server) is a native child webview pinned over this pane, so it
  // exists only in the desktop shell and never in the mobile dock layout. The
  // engine choice is persisted per session, shared with the Agent Team editor's
  // own switcher via the same store.
  const persistedEngine = useProjectEditorSessionStore(
    (state) => state.sessions[scopeKey]?.editorMode
  )
  const setEditorSession = useProjectEditorSessionStore((state) => state.setSession)
  const proIdeAllowed = isTauri() && layout !== "mobile"
  const taskWorkspaceEnabled = useSettingsStore(
    (state) => state.settings?.developer?.taskWorkspace === true
  )
  const activeTask = useTaskWorkspaceStore((state) => state.activeBySession[sessionId])
  const activateTask = useTaskWorkspaceStore((state) => state.activate)
  const hasTaskScope = taskWorkspaceEnabled && Boolean(activeTask)
  const visibleScope = hasTaskScope ? scope : "workspace"

  // Task scope replaces the editor body with the task resources panel and hides
  // the engine toggle, so Pro IDE cannot be running or switched there. Deriving
  // the engine down to Monaco rather than leaving the persisted value showing
  // through fixes a dead reveal path: with `engine` still "codeserver" the
  // Monaco workbench was told not to register a project-editor opener, while
  // CodeServerPane was not mounted to register one either — so nothing claimed
  // the root and every terminal / review file jump silently fell back to the
  // read-only viewer. The persisted choice is untouched, so leaving task scope
  // restores Pro IDE.
  const engine =
    proIdeAllowed && visibleScope === "workspace" && persistedEngine === "codeserver"
      ? "codeserver"
      : "monaco"
  const setEngine = useCallback(
    (next: "monaco" | "codeserver") => setEditorSession(scopeKey, { editorMode: next }),
    [scopeKey, setEditorSession]
  )
  const proIdeSupport = useCodeServerSupported(proIdeAllowed)

  const workbench = useProjectEditorWorkbench({
    scopeKey,
    workingDir,
    beforeOpen: showFileSurface,
    // Whichever engine is mounted owns project-editor jumps; in Pro IDE mode the
    // CodeServerPane registers the opener instead.
    registerProjectOpener: engine === "monaco",
  })
  const { gotoLine } = workbench
  const editor = workbench.editor

  useEffect(() => {
    if (!taskWorkspaceEnabled || activeTask) return
    let cancelled = false
    void listTaskWorkspaces(sessionId)
      .then(async (tasks) => {
        const task = tasks.find((item) => item.workspaceRoot === workingDir)
        if (!task) return
        const runs = await listTaskRuns(task.taskId)
        const run = runs.at(-1)
        if (!run || cancelled) return
        activateTask({
          taskId: task.taskId,
          runId: run.runId,
          sessionId,
          workspaceRoot: task.workspaceRoot,
          executionRoot: run.executionRoot,
          state: run.state,
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeTask, activateTask, sessionId, taskWorkspaceEnabled, workingDir])
  const {
    roots,
    rootKey,
    rootPath,
    openFiles,
    activePath,
    dirtyCount,
    selectRoot,
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
  const selectReviewFile = useCallback(
    (path: string, staged: boolean) => {
      selectFile(path, staged)
      if (layout === "mobile") setMobileReviewPane("diff")
    },
    [layout, selectFile]
  )

  useEffect(() => {
    if (!request || request.id === processedRequest.current) return
    if (request.sessionId !== sessionId || request.rootPath !== workingDir) return
    if (rootKey !== workingDir || rootPath !== workingDir) {
      selectRoot(workingDir)
      return
    }
    processedRequest.current = request.id
    if (request.kind === "review") {
      if (request.relPath) selectFile(request.relPath, false)
      // Always target the review surface. `visibleSurface` below falls back to
      // the file surface until git status hydrates, then flips to review once
      // `hasReview` resolves — so a review reveal fired before git finished
      // loading (the common terminal "view diff" case) no longer gets stuck on
      // the file surface. Deferred to a microtask so we don't setState
      // synchronously inside the effect body.
      queueMicrotask(() => {
        if (processedRequest.current === request.id) setSurface("review")
        clearRequest(request.id)
      })
      return
    }
    // A3: in Pro IDE (code-server) mode the Monaco workbench is unmounted, so its
    // `gotoLine` would open the file in a hidden editor. Route file reveals to the
    // live code-server instead (companion extension, CLI reuse-window fallback).
    if (engine === "codeserver") {
      const relPath = request.relPath
      const line = request.line
      const column = request.column
      void codeServerClient
        .driveOpen(rootPath, joinProjectPath(rootPath, relPath), line, column)
        .catch(() => codeServerClient.openFile(rootPath, relPath, line, column).catch(() => {}))
      if (processedRequest.current === request.id) setSurface("file")
      clearRequest(request.id)
      return
    }
    gotoLine(request.relPath, request.line, request.column)
    if (processedRequest.current === request.id) setSurface("file")
    clearRequest(request.id)
  }, [
    request,
    sessionId,
    workingDir,
    rootKey,
    rootPath,
    engine,
    selectRoot,
    selectFile,
    gotoLine,
    clearRequest,
  ])

  const visibleSurface = hasReview ? surface : "file"
  const reviewEmpty = (
    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
      {t("reviewEmpty")}
    </div>
  )
  const changesPane = status ? (
    <ChangesView
      variant="review"
      rootDir={rootPath}
      actions={gitActions}
      status={status}
      committing={committing}
      selectedPath={selectedPath}
      onSelectFile={selectReviewFile}
      density={layout === "mobile" ? "touch" : "compact"}
    />
  ) : (
    reviewEmpty
  )
  const diffPane = selectedPath ? (
    <DiffPane
      rootDir={rootPath}
      path={selectedPath}
      staged={selectedStaged}
      actions={gitActions}
      density={layout === "mobile" ? "touch" : "compact"}
      // The chat could already send the user here (the Edit/Write review
      // bridge, the workspace-changes card), but nothing could carry a change
      // back — reading that the assistant got a file wrong meant re-describing
      // it by hand. Staged as a chip rather than sent outright so the user
      // still writes the message that goes with it.
      onSendToChat={({ path, diffText }) =>
        addContextSelection({
          kind: "file",
          relPath: path,
          title: path.split("/").pop() ?? path,
          snapshot: diffText,
          comment: "",
        })
      }
    />
  ) : (
    reviewEmpty
  )

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="dock-workspace"
      onKeyDown={workbench.onKeyDown}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1">
        <ProjectRootSwitcher
          roots={roots}
          rootKey={rootKey}
          onSelect={selectRoot}
          density={layout === "mobile" ? "touch" : "compact"}
        />
        <div className="ml-auto flex items-center gap-2">
          {hasTaskScope && (
            <div
              className="flex rounded-md border bg-muted/30 p-0.5"
              role="group"
              aria-label={t("scopeLabel")}
            >
              <button
                type="button"
                aria-pressed={visibleScope === "task"}
                className={cn(
                  "rounded px-2 py-1 text-xs",
                  visibleScope === "task" ? "bg-background shadow-sm" : "text-muted-foreground"
                )}
                onClick={() => setScope("task")}
              >
                {t("currentTask")}
              </button>
              <button
                type="button"
                aria-pressed={visibleScope === "workspace"}
                className={cn(
                  "rounded px-2 py-1 text-xs",
                  visibleScope === "workspace" ? "bg-background shadow-sm" : "text-muted-foreground"
                )}
                onClick={() => setScope("workspace")}
              >
                {t("allWorkspace")}
              </button>
            </div>
          )}
          {proIdeAllowed && visibleScope === "workspace" && (
            <EditorEngineToggle
              value={engine}
              onChange={setEngine}
              proIdeSupport={proIdeSupport}
              projectRoot={rootPath}
            />
          )}
        </div>
      </div>
      {visibleScope === "task" ? (
        <div className="min-h-0 flex-1">
          <TaskResourcesPanel sessionId={sessionId} layout={layout} />
        </div>
      ) : (
        <>
          <ProjectEditorTabs
            density={layout === "mobile" ? "touch" : "compact"}
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
            // Pro IDE keeps its own editor tabs inside VS Code; showing Monaco's
            // open-file strip alongside would list a different set of files. The
            // strip still renders so the fixed "review" tab stays reachable.
            files={engine === "codeserver" ? [] : openFiles}
            activePath={visibleSurface === "file" ? activePath : null}
            dirtyCount={engine === "codeserver" ? 0 : dirtyCount}
            onSelect={(path) => {
              setSurface("file")
              if (layout === "mobile") workbench.setMobilePane("editor")
              setActivePath(path)
            }}
            onClose={closeFile}
            onSaveAll={workbench.saveAll}
          />

          {visibleSurface === "review" && hasReview ? (
            <div className="min-h-0 flex-1" data-testid="workspace-review-layout">
              {layout === "mobile" ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div
                    className="grid shrink-0 grid-cols-2 border-b bg-background/95 p-1"
                    data-testid="workspace-mobile-review-tabs"
                  >
                    <button
                      type="button"
                      data-testid="workspace-mobile-review-changes"
                      aria-pressed={mobileReviewPane === "changes"}
                      className={cn(
                        "min-h-11 rounded-md px-3 text-sm",
                        mobileReviewPane === "changes" ? "bg-accent" : "text-muted-foreground"
                      )}
                      onClick={() => setMobileReviewPane("changes")}
                    >
                      {t("reviewChanges")}
                    </button>
                    <button
                      type="button"
                      data-testid="workspace-mobile-review-diff"
                      aria-pressed={mobileReviewPane === "diff"}
                      className={cn(
                        "min-h-11 rounded-md px-3 text-sm",
                        mobileReviewPane === "diff" ? "bg-accent" : "text-muted-foreground"
                      )}
                      onClick={() => setMobileReviewPane("diff")}
                    >
                      {t("reviewDiff")}
                    </button>
                  </div>
                  <div className="min-h-0 flex-1">
                    {mobileReviewPane === "changes" ? changesPane : diffPane}
                  </div>
                </div>
              ) : status ? (
                <ResizablePanelGroup orientation="horizontal" className="h-full">
                  <ResizablePanel id="workspace-review-changes" defaultSize="38%" minSize="25%">
                    {changesPane}
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel id="workspace-review-diff" defaultSize="62%" minSize="35%">
                    {diffPane}
                  </ResizablePanel>
                </ResizablePanelGroup>
              ) : (
                reviewEmpty
              )}
            </div>
          ) : (
            <div className="min-h-0 flex-1" data-testid="workspace-file-layout">
              {engine === "codeserver" ? (
                <CodeServerPane
                  root={rootPath}
                  ownerId={scopeKey}
                  onRevoked={() => setEngine("monaco")}
                  onCancelled={() => setEngine("monaco")}
                />
              ) : (
                <ProjectEditorFileWorkbench
                  workbench={workbench}
                  sidebarPosition="right"
                  panelIdPrefix="workspace"
                  showContextWorkbench={false}
                  layout={layout === "mobile" ? "mobile" : "split"}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
