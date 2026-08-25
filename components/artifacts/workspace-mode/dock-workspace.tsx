"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { GitCompareArrowsIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import type { SessionExecutionContext } from "@/types/execution-context"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { CodeServerPane, joinProjectPath } from "@/components/editor/project/code-server-pane"
import { EditorEngineToggle } from "@/components/editor/project/editor-engine-toggle"
import { type CodeServerProfile, codeServerClient } from "@/lib/codeserver/client"
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
import { primaryRootOf } from "@/lib/workspace/roots"
import { resolveSessionExecutionRoot } from "@/lib/workspace/session-root"
import { resolvePanelRoot } from "@/lib/workspace/panel-follow"
import { PanelRootChip } from "@/components/workspace/panel-root-chip"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useProjectEditorSessionStore } from "@/stores/editor/project-editor-session-store"
import { useGitStore } from "@/stores/git/git-store"
import { useProjectStore } from "@/stores/project/project-store"
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

  // The conversation's execution root, not the workspace's primary root — the
  // editor is where a user reads what the agent just wrote, and pointing it at
  // the checkout a worktree was cut from shows them a stale copy of the file.
  const { project, root: followedRoot } = resolveSessionExecutionRoot(session, projects)
  const executionContext = session.executionContext ?? null
  // Worktree discovery still runs from the REPOSITORY: `git worktree list` in a
  // worktree would label that worktree "main" and skip the real one.
  const repoRoot = project ? primaryRootOf(project)?.path : undefined
  if (!project) {
    return (
      <WorkspaceEmpty
        testId="workspace-project-missing"
        title={t("missingProject.title")}
        description={t("missingProject.description")}
      />
    )
  }

  const workingDir = repoRoot ?? followedRoot
  if (!workingDir) {
    return (
      <WorkspaceEmpty
        testId="workspace-root-missing"
        title={t("missingRoot.title")}
        description={t("missingRoot.description")}
      />
    )
  }

  return (
    <WorkspaceEditorBody
      sessionId={session.id}
      workingDir={workingDir}
      followedRoot={followedRoot}
      executionContext={executionContext}
      project={project}
      layout={layout}
    />
  )
}

function WorkspaceEditorBody({
  sessionId,
  workingDir,
  followedRoot,
  executionContext,
  project,
  layout,
}: {
  sessionId: string
  workingDir: string
  /**
   * Where the bound conversation runs; the editor follows it unless pinned.
   * Absent on the reveal path, which names a directory directly and has no
   * follow relationship to show.
   */
  followedRoot?: string | null
  /**
   * Passed down rather than re-read through `useSessionExecutionContext`: the
   * component above already holds the live session row, and a second
   * subscription to it could momentarily disagree with the root this body was
   * handed.
   */
  executionContext?: SessionExecutionContext | null
  project?: Pick<Project, "roots"> | null
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
  const persistedProfile = useProjectEditorSessionStore(
    (state) => state.sessions[scopeKey]?.proIdeProfile
  )
  const setEditorSession = useProjectEditorSessionStore((state) => state.setSession)
  const proIdeAllowed = isTauri() && layout !== "mobile"
  const activeTask = useTaskWorkspaceStore((state) => state.activeBySession[sessionId])
  const activateTask = useTaskWorkspaceStore((state) => state.activate)
  const hasTaskScope = Boolean(activeTask)
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
  // Shares the per-scope record with the Agent Team editor's switcher, exactly
  // like `editorMode` — the two hosts must not disagree about which code-server
  // process this scope is looking at.
  const proIdeProfile: CodeServerProfile = persistedProfile === "native" ? "native" : "managed"
  const setProIdeProfile = useCallback(
    (next: CodeServerProfile) => setEditorSession(scopeKey, { proIdeProfile: next }),
    [scopeKey, setEditorSession]
  )
  const proIdeSupport = useCodeServerSupported(proIdeAllowed)

  const workbench = useProjectEditorWorkbench({
    scopeKey,
    workingDir,
    followedRoot,
    beforeOpen: showFileSurface,
    // Whichever engine is mounted owns project-editor jumps; in Pro IDE mode the
    // CodeServerPane registers the opener instead.
    registerProjectOpener: engine === "monaco",
  })
  const { gotoLine } = workbench
  const editor = workbench.editor

  useEffect(() => {
    if (activeTask) return
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
  }, [activeTask, activateTask, sessionId, workingDir])
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
    pinned,
    resumeFollow,
  } = editor

  // One resolver for every directory-facing panel. The pin layer is fed from
  // the editor's own selection rather than a separate store — for this panel
  // the selection IS the pin, so a second home for it would be a second answer.
  const rootTarget = useMemo(() => {
    const target = resolvePanelRoot({
      panel: "editor",
      executionContext,
      activeProject: project,
      pinnedRoot: pinned ? rootPath : null,
    })
    // The reveal path names a directory outright and carries neither a binding
    // nor a workspace. Reporting "no root" while the editor is plainly rooted
    // somewhere is the exact dishonesty this chip exists to remove.
    if (!target.root) return { root: rootPath, source: "workspace" as const, managed: false }
    if (target.source !== "pinned" || target.managed) return target
    // A pin onto SOME OTHER worktree is still a worktree, and the chip's job is
    // to say so. The resolver can only recognise the conversation's own alias;
    // the roots list is the only thing that knows about the rest.
    const selected = roots.find((candidate) => candidate.key === rootPath)
    return selected && !selected.isMain ? { ...target, managed: true } : target
  }, [executionContext, project, pinned, rootPath, roots])

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
    if (request.sessionId !== sessionId) return
    // Match the request against the roots this editor can actually select, not
    // against the repository root. An agent edit inside a managed worktree
    // arrives with the worktree's path, and comparing it to the repository made
    // every such reveal fall out here silently — no error, no panel, no clue.
    const requestedRoot = roots.find((candidate) => candidate.key === request.rootPath)?.key
    if (!requestedRoot) return
    if (rootKey !== requestedRoot || rootPath !== requestedRoot) {
      selectRoot(requestedRoot)
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
    roots,
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
      className="flex h-full w-full min-h-0 min-w-0 max-w-full flex-col overflow-x-hidden"
      data-testid="dock-workspace"
      onKeyDown={workbench.onKeyDown}
    >
      {roots.length > 1 || hasTaskScope || rootTarget.root ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b px-2 py-1"
          data-testid="dock-workspace-toolbar"
        >
          <ProjectRootSwitcher
            roots={roots}
            rootKey={rootKey}
            onSelect={selectRoot}
            followedRoot={followedRoot}
            density={layout === "mobile" ? "touch" : "compact"}
          />
          <PanelRootChip
            panel="editor"
            target={rootTarget}
            {
              /* Only while pinned. Following has no "pin here" to offer — the
                root switcher above is how you pin, and a control that did
                nothing would be the dead affordance the chip exists to avoid. */
              ...(pinned ? { onTogglePin: resumeFollow } : {})
            }
            className="min-w-0"
          />
          {hasTaskScope ? (
            <div
              className="ml-auto flex rounded-md border bg-muted/30 p-0.5"
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
          ) : null}
        </div>
      ) : null}
      {visibleScope === "task" ? (
        <div className="min-h-0 flex-1">
          <TaskResourcesPanel sessionId={sessionId} layout={layout} />
        </div>
      ) : (
        <>
          <ProjectEditorTabs
            density={layout === "mobile" ? "touch" : "compact"}
            trailingContent={
              proIdeAllowed && visibleScope === "workspace" ? (
                <EditorEngineToggle
                  value={engine}
                  onChange={setEngine}
                  proIdeSupport={proIdeSupport}
                  projectRoot={rootPath}
                  proIdeProfile={proIdeProfile}
                  onProIdeProfileChange={setProIdeProfile}
                />
              ) : undefined
            }
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

          {engine === "codeserver" ? (
            <div
              className={cn("min-h-0 flex-1", visibleSurface !== "file" && "hidden")}
              data-testid="workspace-code-server-host"
              data-active={visibleSurface === "file"}
            >
              <CodeServerPane
                root={rootPath}
                ownerId={scopeKey}
                profile={proIdeProfile}
                beforeOpen={showFileSurface}
                onRevoked={() => setEngine("monaco")}
                onCancelled={() => setEngine("monaco")}
              />
            </div>
          ) : null}

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
          ) : engine === "monaco" ? (
            <div
              className="min-h-0 min-w-0 max-w-full flex-1 overflow-hidden"
              data-testid="workspace-file-layout"
            >
              <ProjectEditorFileWorkbench
                workbench={workbench}
                sidebarPosition="right"
                panelIdPrefix="workspace"
                showContextWorkbench={false}
                layout={layout === "mobile" ? "mobile" : "split"}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
