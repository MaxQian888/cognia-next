"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FileCodeIcon, FolderTreeIcon, GitCompareArrowsIcon, ListChecksIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import type { SessionExecutionContext } from "@/types/execution-context"
import type { ReviewScopeChoice } from "@/types/review"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { CodeServerPane, joinProjectPath } from "@/components/editor/project/code-server-pane"
import { CodeServerWebPane } from "@/components/editor/project/code-server-web-pane"
import { EditorEngineToggle } from "@/components/editor/project/editor-engine-toggle"
import { type CodeServerProfile, codeServerClient } from "@/lib/codeserver/client"
import { ProjectRootSwitcher } from "@/components/editor/project/project-root-switcher"
import {
  ProjectEditorFileWorkbench,
  useProjectEditorWorkbench,
} from "@/components/editor/project/project-editor-workbench"
import { useChatStore } from "@/stores/chat"
import { useClientLiveQuery } from "@/hooks/data"
import { useGitActions } from "@/hooks/git/use-git-actions"
import { getSession } from "@/lib/db/sessions"
import { useCodeServerSupported } from "@/hooks/codeserver/use-code-server-supported"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { refreshGitStatus } from "@/lib/git/load"
import { resolveReviewSide } from "@/lib/git/diff-presentation"
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
import { WorkspaceFilePreview } from "./workspace-file-preview"
import { WorkspaceReview } from "./workspace-review"
import { isSnapshotSelection } from "./snapshot-review"
import { changedPathCount } from "@/lib/git/conversation-scope"

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
  const editorLabels = useTranslations("projectEditor")
  const request = useArtifactDockLayoutStore((state) => state.workspaceRevealRequest)
  const clearRequest = useArtifactDockLayoutStore((state) => state.clearWorkspaceRevealRequest)
  const addContextSelection = useChatStore((state) => state.addContextSelection)
  const [surface, setSurface] = useState<"file" | "review">("file")
  const [scope, setScope] = useState<"task" | "workspace">("task")
  /**
   * The file a reveal asked a phone to show. Mobile only: the desktop dock
   * opens the editable editor directly, while a phone gets the focused
   * read-only preview (`WorkspaceFilePreview`) over the workspace surfaces,
   * with "Edit" one tap away.
   */
  const [mobilePreview, setMobilePreview] = useState<{
    root: string
    relPath: string
    line?: number
    column?: number
  } | null>(null)
  const processedRequest = useRef<string | null>(null)
  /** The last review reveal that named a file; opens its diff (WorkspaceReview `focus`). */
  const [reviewFocus, setReviewFocus] = useState<{
    id: string
    file: { path: string; staged: boolean }
  } | null>(null)
  /** The last review reveal that named a scope (WorkspaceReview `scopeRequest`). */
  const [reviewScopeRequest, setReviewScopeRequest] = useState<{
    id: string
    choice: ReviewScopeChoice
    relPath?: string
  } | null>(null)
  // Any editor open has to land on a surface the user can see. Task scope
  // replaces the editor with the task ledger, so an open that only flipped the
  // Editor/Review switch — a chat file link, a terminal path, a search hit —
  // loaded the file into an editor hidden behind the ledger and showed nothing.
  const showFileSurface = useCallback(() => {
    setSurface("file")
    setScope("workspace")
  }, [])
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
  // Pro IDE needs a HOST that can run a workbench, not a desktop shell. Gating
  // on `isTauri()` said "not supported on this platform" to every browser and
  // phone, including a tab on the host's own machine that can reach the
  // workbench over loopback. `hasWorkspaceFsBackend` is the same "is there a
  // host" question the workspace panel around this already answers with, and
  // `CodeServerWebPane` states the remaining reason when a browser cannot show
  // it. Phones stay out on width, which is a layout decision, not a reach one.
  const proIdeAllowed = hasWorkspaceFsBackend() && layout !== "mobile"
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
    layout: layout === "mobile" ? "mobile" : "split",
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
  const { roots, rootKey, rootPath, selectRoot, pinned, resumeFollow } = editor

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
  // Distinct paths across every group — a file staged and then edited again
  // is one change to review, not two.
  const changeCount = useMemo(() => changedPathCount(status), [status])
  const refresh = useCallback(() => refreshGitStatus(rootPath), [rootPath])
  const gitActions = useGitActions(refresh)
  const reviewSelection = useMemo(
    () => (selectedPath ? { path: selectedPath, staged: selectedStaged } : null),
    [selectedPath, selectedStaged]
  )
  const selectReviewFile = useCallback(
    (file: { path: string; staged: boolean } | null) =>
      selectFile(file?.path ?? null, file?.staged ?? false),
    [selectFile]
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
      // The side that holds the change: a file that is only staged has an
      // empty working-tree diff, and asking for that one opened a blank pane.
      // The review surface then opens straight into this file's diff. A turn,
      // commit or branch reveal is not about the working tree, so it has no
      // side; the snapshot review opens the file itself.
      const snapshotReveal = request.scope ? isSnapshotSelection(request.scope) : false
      const side =
        request.relPath && !snapshotReveal ? resolveReviewSide(status, request.relPath) : null
      if (side) selectFile(side.path, side.staged)
      // Always target the review surface. `visibleSurface` below falls back to
      // the file surface until git status hydrates, then flips to review once
      // `hasReview` resolves — so a review reveal fired before git finished
      // loading (the common terminal "view diff" case) no longer gets stuck on
      // the file surface. Deferred to a microtask so we don't setState
      // synchronously inside the effect body.
      queueMicrotask(() => {
        if (processedRequest.current === request.id) {
          if (side) setReviewFocus({ id: request.id, file: side })
          if (request.scope) {
            setReviewScopeRequest({
              id: request.id,
              choice: request.scope,
              ...(request.relPath ? { relPath: request.relPath } : {}),
            })
          }
          setSurface("review")
          // The review surface lives under workspace scope; left on the task
          // ledger the reveal would select a file in a pane nobody can see.
          setScope("workspace")
        }
        clearRequest(request.id)
      })
      return
    }
    // A phone gets the read-only preview rather than the editor: one Host read,
    // a full-height text view with its own loading/error/empty states, and no
    // virtual keyboard. "Edit" from there runs the desktop path below.
    if (layout === "mobile") {
      const preview = {
        root: rootPath,
        relPath: request.relPath,
        line: request.line,
        column: request.column,
      }
      queueMicrotask(() => {
        if (processedRequest.current === request.id) {
          setScope("workspace")
          setMobilePreview(preview)
        }
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
    layout,
    engine,
    selectRoot,
    selectFile,
    status,
    gotoLine,
    clearRequest,
  ])

  const visibleSurface = hasReview ? surface : "file"
  // The chat could already send the user here (the Edit/Write review bridge,
  // the workspace-changes card), but nothing could carry a change back —
  // reading that the assistant got a file wrong meant re-describing it by
  // hand. Staged as a chip rather than sent outright so the user still writes
  // the message that goes with it.
  const sendDiffToChat = useCallback(
    ({ path, diffText }: { path: string; diffText: string }) =>
      addContextSelection({
        kind: "file",
        relPath: path,
        title: path.split("/").pop() ?? path,
        snapshot: diffText,
        comment: "",
      }),
    [addContextSelection]
  )

  const touch = layout === "mobile"
  // From a diff to the file itself, on the editor surface and at the change.
  // Pro IDE takes the open when it is the mounted engine, like any reveal.
  const openReviewFileInEditor = useCallback(
    (path: string, line?: number) => {
      if (engine === "codeserver") {
        showFileSurface()
        void codeServerClient
          .driveOpen(rootPath, joinProjectPath(rootPath, path), line, 1)
          .catch(() => codeServerClient.openFile(rootPath, path, line, 1).catch(() => {}))
        return
      }
      // gotoLine runs the workbench's beforeOpen, which is showFileSurface.
      gotoLine(path, line)
    },
    [engine, gotoLine, rootPath, showFileSurface]
  )
  const openPreviewInEditor = useCallback(() => {
    if (!mobilePreview) return
    gotoLine(mobilePreview.relPath, mobilePreview.line, mobilePreview.column)
    setMobilePreview(null)
  }, [gotoLine, mobilePreview])
  const zen = workbench.zenMode && !touch && engine === "monaco" && visibleSurface === "file"
  // One visual language for every switch on the toolbar row — the engine
  // toggle beside them is the same outline ToggleGroup.
  const toggleItemClass = cn(
    "gap-1 text-xs",
    touch ? "h-9 min-w-0 flex-1 px-3 text-sm" : "h-7 px-2"
  )
  // A phone stretches each switch across the sheet so its labels never clip;
  // two switches share a row while each keeps 10rem, and stack below that.
  const toggleGroupClass = touch ? "min-w-[10rem] flex-1" : undefined
  const touchLabelClass = touch ? "truncate" : undefined
  // The dock runs from its 480px floor to ~900px, and one row has to hold the
  // root controls and up to three switches. Rather than wrap onto a second row
  // (a band of chrome the editor pays for in height), the switches drop their
  // words for their icons as the dock narrows — the scope and engine switches
  // first, the Editor/Review switch last. Touch keeps its labels: the phone
  // sheet wraps instead, and icon-only targets are guesswork on a phone.
  const scopeLabelClass = touch ? touchLabelClass : "hidden @3xl/dock-ws:inline"
  const surfaceLabelClass = touch ? touchLabelClass : "hidden @2xl/dock-ws:inline"
  const showSurfaceSwitch = visibleScope === "workspace" && hasReview
  const showEngineToggle = proIdeAllowed && visibleScope === "workspace"
  const hasSwitches = showSurfaceSwitch || showEngineToggle || hasTaskScope

  return (
    <div
      className="@container/dock-ws relative flex h-full w-full min-h-0 min-w-0 max-w-full flex-col overflow-x-hidden"
      data-testid="dock-workspace"
    >
      {touch && mobilePreview ? (
        // An overlay rather than a swap: the editor workbench underneath keeps
        // its open tabs and its registered project opener while the preview
        // is up, so "Edit" and Back both return to a live editor.
        <div className="absolute inset-0 z-20 bg-background" data-testid="workspace-preview-layer">
          <WorkspaceFilePreview
            key={`${mobilePreview.root}:${mobilePreview.relPath}:${mobilePreview.line ?? ""}`}
            root={mobilePreview.root}
            relPath={mobilePreview.relPath}
            line={mobilePreview.line}
            column={mobilePreview.column}
            onBack={() => setMobilePreview(null)}
            onOpenInEditor={openPreviewInEditor}
          />
        </div>
      ) : null}
      <div
        className={cn(
          "flex min-w-0 shrink-0 items-center gap-x-2 gap-y-1 border-b bg-muted/20 px-2 py-1",
          touch ? "flex-wrap" : "flex-nowrap"
        )}
        data-testid="dock-workspace-toolbar"
        // Zen hides every surface around the text; the dock's own toolbar is
        // one of them. Esc Esc (or ⌘K Z) inside the editor brings it back.
        hidden={zen}
      >
        <ProjectRootSwitcher
          roots={roots}
          rootKey={rootKey}
          onSelect={selectRoot}
          followedRoot={followedRoot}
          density={touch ? "touch" : "compact"}
        />
        <PanelRootChip
          panel="editor"
          target={rootTarget}
          {
            /* Only while pinned. Following has no "pin here" to offer — the
              root switcher beside it is how you pin, and a control that did
              nothing would be the dead affordance the chip exists to avoid. */
            ...(pinned ? { onTogglePin: resumeFollow } : {})
          }
          className="min-w-0"
        />
        {hasSwitches ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5",
              // A phone gives the switches a full row of their own, stretched,
              // instead of squeezing them beside the root chip.
              touch ? "w-full flex-wrap" : "ml-auto shrink-0 flex-nowrap justify-end"
            )}
            data-testid="dock-workspace-switches"
          >
            {showSurfaceSwitch ? (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={visibleSurface}
                // Radix lets the pressed item deselect itself, which would leave
                // the dock showing nothing — an empty value is ignored instead.
                onValueChange={(next) => {
                  if (next === "file" || next === "review") setSurface(next)
                }}
                aria-label={t("surfaceLabel")}
                className={toggleGroupClass}
                data-testid="workspace-surface-switch"
              >
                <ToggleGroupItem
                  value="file"
                  className={toggleItemClass}
                  data-testid="workspace-surface-file"
                  aria-label={editorLabels("editorTab")}
                  title={touch ? undefined : editorLabels("editorTab")}
                >
                  <FileCodeIcon className="size-3.5" />
                  <span className={surfaceLabelClass}>{editorLabels("editorTab")}</span>
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="review"
                  className={toggleItemClass}
                  data-testid="workspace-surface-review"
                  aria-label={
                    changeCount > 0 ? t("reviewWithCount", { count: changeCount }) : t("review")
                  }
                  title={
                    touch
                      ? undefined
                      : changeCount > 0
                        ? t("reviewWithCount", { count: changeCount })
                        : t("review")
                  }
                >
                  <GitCompareArrowsIcon className="size-3.5" />
                  <span className={surfaceLabelClass}>{t("review")}</span>
                  {changeCount > 0 ? (
                    <span
                      className="min-w-4 rounded-pill bg-primary/15 px-1 text-[10px] font-semibold leading-4 text-primary tabular-nums"
                      data-testid="workspace-review-count"
                      aria-hidden
                    >
                      {changeCount > 99 ? "99+" : changeCount}
                    </span>
                  ) : null}
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}
            {showEngineToggle ? (
              <EditorEngineToggle
                value={engine}
                onChange={setEngine}
                proIdeSupport={proIdeSupport}
                projectRoot={rootPath}
                proIdeProfile={proIdeProfile}
                onProIdeProfileChange={setProIdeProfile}
                labelClassName={scopeLabelClass}
              />
            ) : null}
            {hasTaskScope ? (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={visibleScope}
                onValueChange={(next) => {
                  if (next === "task" || next === "workspace") setScope(next)
                }}
                aria-label={t("scopeLabel")}
                className={toggleGroupClass}
                data-testid="workspace-scope-switch"
              >
                <ToggleGroupItem
                  value="task"
                  className={toggleItemClass}
                  data-testid="workspace-scope-task"
                  aria-label={t("currentTask")}
                  title={touch ? undefined : t("currentTask")}
                >
                  <ListChecksIcon className="size-3.5" />
                  <span className={scopeLabelClass}>{t("currentTask")}</span>
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="workspace"
                  className={toggleItemClass}
                  data-testid="workspace-scope-all"
                  aria-label={t("allWorkspace")}
                  title={touch ? undefined : t("allWorkspace")}
                >
                  <FolderTreeIcon className="size-3.5" />
                  <span className={scopeLabelClass}>{t("allWorkspace")}</span>
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}
          </div>
        ) : null}
      </div>
      {visibleScope === "task" ? (
        <div className="min-h-0 flex-1">
          <TaskResourcesPanel sessionId={sessionId} layout={layout} />
        </div>
      ) : (
        <>
          {engine === "codeserver" ? (
            <div
              className={cn("min-h-0 flex-1", visibleSurface !== "file" && "hidden")}
              data-testid="workspace-code-server-host"
              data-active={visibleSurface === "file"}
            >
              {isTauri() ? (
                <CodeServerPane
                  root={rootPath}
                  ownerId={scopeKey}
                  profile={proIdeProfile}
                  beforeOpen={showFileSurface}
                  onRevoked={() => setEngine("monaco")}
                  onCancelled={() => setEngine("monaco")}
                />
              ) : (
                // No native webview to pin, and no shared pane to hand off, so
                // none of the desktop pane's ownership plumbing applies here.
                <CodeServerWebPane
                  root={rootPath}
                  profile={proIdeProfile}
                  beforeOpen={showFileSurface}
                />
              )}
            </div>
          ) : null}

          {engine === "monaco" ? (
            <div
              className="min-h-0 min-w-0 max-w-full flex-1 overflow-hidden"
              data-testid="workspace-file-layout"
              hidden={visibleSurface !== "file"}
              // Editor chords belong to the editor surface alone: bound on the
              // dock root they also fired from the Review and task surfaces,
              // saving or closing a tab nobody could see.
              onKeyDown={workbench.onKeyDown}
            >
              <ProjectEditorFileWorkbench
                workbench={workbench}
                active={visibleSurface === "file"}
                panelIdPrefix="workspace"
              />
            </div>
          ) : null}

          {visibleSurface === "review" && hasReview ? (
            <div className="min-h-0 flex-1" data-testid="workspace-review-layout">
              <WorkspaceReview
                rootPath={rootPath}
                sessionId={sessionId}
                status={status}
                actions={gitActions}
                committing={committing}
                selected={reviewSelection}
                onSelect={selectReviewFile}
                layout={layout}
                onSendToChat={sendDiffToChat}
                onOpenInEditor={openReviewFileInEditor}
                focus={reviewFocus}
                scopeRequest={reviewScopeRequest}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
