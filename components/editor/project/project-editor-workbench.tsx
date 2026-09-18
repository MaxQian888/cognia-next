"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { CodeIcon, FilesIcon, PanelRightIcon, SaveIcon, SearchIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { LightCodeEditor } from "@/components/editor/light-code-editor"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import type { EditorActionDef } from "@/lib/editor-workbench/register-editor-actions"
import type { EditorTabMode } from "@/lib/editor-workbench/editor-tab-model"
import {
  notifyActiveEditorChanged,
  registerProjectEditorOpener,
  type ActiveEditorContext,
} from "@/lib/files/project-editor-bridge"
// Separator-aware join from the instructions helpers — a dependency-free leaf.
// Deliberately not `code-server-pane`'s `joinProjectPath`: importing that would
// drag the whole Tauri-coupled Pro IDE component into the Monaco path, and it
// hardcodes `/` besides.
import { joinPath } from "@/lib/claude/instructions/paths"
import { cn } from "@/lib/utils"
import { readMonacoActiveEditor, type ReadableMonacoEditor } from "./monaco-active-editor"
import { useKeybindingStore } from "@/stores/canvas/keybinding-store"
import { PROJECT_EDITOR_GOTO_EVENT } from "./editor-events"
import { ProjectEditorTabs } from "./project-editor-tabs"
import type { FileTreeFailure, FileTreeOperation } from "@/lib/files/file-tree-failure"
import { ProjectFileTree } from "./project-file-tree"
import { ProjectMonaco } from "./project-monaco"
import { ProjectSearchPanel } from "./project-search-panel"
import { useProjectEditor, type OpenFile, type UseProjectEditorArgs } from "./use-project-editor"
import { ProjectContextWorkbench, ProjectContextWorkbenchMobile } from "./project-context-workbench"
import type { TextSelectionCoordinates } from "@/types/context-workbench"
import type { EditorLike, MonacoLike } from "@/hooks/use-monaco-markers"

interface UseProjectEditorWorkbenchArgs extends UseProjectEditorArgs {
  beforeOpen?: () => void
  registerProjectOpener?: boolean
}

/** The live Monaco handles a read needs, as ProjectMonaco hands them over. */
export interface MonacoReadHandles {
  monaco: MonacoLike
  editor: ReadableMonacoEditor
}

export function useProjectEditorWorkbench({
  scopeKey,
  workingDir,
  followedRoot,
  deps,
  beforeOpen,
  registerProjectOpener = true,
}: UseProjectEditorWorkbenchArgs) {
  const t = useTranslations("projectEditor")
  const bindings = useKeybindingStore((state) => state.bindings)
  const [sideTab, setSideTab] = useState<"files" | "search">("files")
  const [mobilePane, setMobilePane] = useState<"files" | "search" | "editor">("files")
  const editor = useProjectEditor({ scopeKey, workingDir, followedRoot, deps })
  const { activeFile, activePath, openFile, rootPath, saveAll, saveFile } = editor

  // Monaco's live handles mount inside ProjectEditorFileWorkbench, but the
  // project-editor opener is registered here. Rather than re-registering the
  // opener whenever the caret moves (which would churn the bridge on every
  // keystroke), the component pushes its handles into this ref and `readActive`
  // reads whatever is current at call time.
  const monacoHandlesRef = useRef<MonacoReadHandles | null>(null)
  const setMonacoReadHandles = useCallback((handles: MonacoReadHandles | null) => {
    monacoHandlesRef.current = handles
  }, [])

  // Same reason: the snapshot's path/openEditors come from state that changes
  // constantly, so they are read through a ref instead of captured. Synced in an
  // effect rather than during render — a render-phase ref write is not safe under
  // concurrent rendering, and `readActive` only ever runs after commit anyway.
  const editorStateRef = useRef({ rootPath, activePath, openFiles: editor.openFiles })
  const { openFiles } = editor
  useEffect(() => {
    editorStateRef.current = { rootPath, activePath, openFiles }
    // Announce the move so `ctx.editor.onDidChangeActiveEditor` subscribers
    // re-read. Without this the event would only fire on mount/unmount, which
    // is not what its name promises.
    notifyActiveEditorChanged()
  }, [activePath, openFiles, rootPath])

  const readActive = useCallback(async (): Promise<ActiveEditorContext> => {
    const { rootPath: root, activePath: active, openFiles } = editorStateRef.current
    const handles = monacoHandlesRef.current
    return readMonacoActiveEditor({
      path: active ? joinPath(root, active) : null,
      openEditors: openFiles.map((file) => joinPath(root, file.relPath)),
      editor: handles?.editor ?? null,
      monaco: handles?.monaco ?? null,
    })
  }, [])

  /**
   * Tree-driven open. A plain click asks for a preview tab (VS Code's single
   * reusable slot) so browsing the tree does not pile up tabs; a double-click
   * pins it. Distinct from `gotoLine`, whose callers — search hits, terminal
   * path links, the agent bridge — always mean "keep this open".
   */
  const openFromTree = useCallback(
    (relPath: string, options?: { mode?: EditorTabMode }) => {
      beforeOpen?.()
      setMobilePane("editor")
      void openFile(relPath, options)
    },
    [beforeOpen, openFile]
  )

  const gotoLine = useCallback(
    (relPath: string, line?: number, column?: number) => {
      beforeOpen?.()
      setMobilePane("editor")
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
    [beforeOpen, openFile]
  )

  /**
   * Flush this workbench's dirty drafts so the agent's disk-based file tools see
   * what the user is actually looking at.
   *
   * Monaco keeps `draftContent` in memory until saved, exactly like a VS Code
   * buffer — so without this the staleness hole the Pro IDE's `saveAll` closes
   * would still be wide open whenever Monaco is the mounted engine. Reports the
   * root on failure, since `saveAll` doesn't say which file it choked on.
   */
  const flushDrafts = useCallback(async () => {
    try {
      await saveAll()
      return []
    } catch {
      return [rootPath]
    }
  }, [rootPath, saveAll])

  useEffect(() => {
    if (!registerProjectOpener) return
    return registerProjectEditorOpener({
      root: rootPath,
      open: gotoLine,
      // No `applyEdit`: Monaco reflects an agent's disk write through its own
      // external-change reload. `readActive`, though, has no such fallback —
      // without it the read side would stay Pro-IDE-only.
      readActive,
      saveDirty: flushDrafts,
    })
  }, [flushDrafts, gotoLine, readActive, registerProjectOpener, rootPath])

  const saveActive = useCallback(() => {
    if (!activePath) return
    void saveFile(activePath).catch((error) =>
      toast.error(t("saveFailed", { error: String(error) }))
    )
  }, [activePath, saveFile, t])

  const saveEveryFile = useCallback(() => {
    void saveAll().catch((error) => toast.error(t("saveFailed", { error: String(error) })))
  }, [saveAll, t])

  const actionLabels = useMemo<Record<string, string>>(
    () => ({
      "file.save": t("action.save"),
      "file.format": t("action.format"),
      "file.copyPath": t("action.copyPath"),
      "file.copyRelativePath": t("action.copyRelativePath"),
      "file.searchProject": t("action.searchProject"),
    }),
    [t]
  )

  const actions = useMemo<EditorActionDef[]>(
    () => [
      {
        id: "file.save",
        label: actionLabels["file.save"],
        contextMenuGroupId: "1_modification",
        contextMenuOrder: 1,
        alwaysAvailable: true,
        run: saveActive,
      },
      {
        id: "file.format",
        label: actionLabels["file.format"],
        monacoCommand: "editor.action.formatDocument",
        contextMenuGroupId: "1_modification",
        contextMenuOrder: 2,
        alwaysAvailable: true,
      },
      {
        id: "file.copyPath",
        label: actionLabels["file.copyPath"],
        contextMenuGroupId: "9_cutcopypaste",
        contextMenuOrder: 1,
        alwaysAvailable: true,
        run: () => {
          if (activeFile) void navigator.clipboard?.writeText(activeFile.absolutePath)
        },
      },
      {
        id: "file.copyRelativePath",
        label: actionLabels["file.copyRelativePath"],
        contextMenuGroupId: "9_cutcopypaste",
        contextMenuOrder: 2,
        alwaysAvailable: true,
        run: () => {
          if (activeFile) void navigator.clipboard?.writeText(activeFile.relPath)
        },
      },
      {
        id: "file.searchProject",
        label: actionLabels["file.searchProject"],
        contextMenuGroupId: "z_search",
        alwaysAvailable: true,
        run: () => {
          setSideTab("search")
          setMobilePane("search")
        },
      },
    ],
    [actionLabels, activeFile, saveActive]
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return
      event.preventDefault()
      if (event.shiftKey) saveEveryFile()
      else saveActive()
    },
    [saveActive, saveEveryFile]
  )

  return {
    editor,
    bindings,
    sideTab,
    setSideTab,
    mobilePane,
    setMobilePane,
    gotoLine,
    openFromTree,
    saveActive,
    saveAll: saveEveryFile,
    actionLabels,
    actions,
    onKeyDown,
    setMonacoReadHandles,
  }
}

export type ProjectEditorWorkbenchController = ReturnType<typeof useProjectEditorWorkbench>

interface ProjectEditorFileWorkbenchProps {
  workbench: ProjectEditorWorkbenchController
  sidebarPosition: "left" | "right"
  panelIdPrefix: string
  showTabs?: boolean
  showContextWorkbench?: boolean
  emptyTestId?: string
  layout?: "split" | "mobile"
}

export function ProjectEditorFileWorkbench({
  workbench,
  sidebarPosition,
  panelIdPrefix,
  showTabs = false,
  showContextWorkbench = true,
  emptyTestId = "editor-empty",
  layout = "split",
}: ProjectEditorFileWorkbenchProps) {
  const t = useTranslations("projectEditor")
  const contextWorkbenchVisible = showContextWorkbench
  const [mobileWorkbenchOpen, setMobileWorkbenchOpen] = useState(false)
  const [editorSelectionState, setEditorSelectionState] = useState<{
    relPath: string
    selection: TextSelectionCoordinates | undefined
  } | null>(null)
  const [diagnosticsState, setDiagnosticsState] = useState<{
    relPath: string
    diagnostics: { monaco: MonacoLike; editor: EditorLike } | null
  } | null>(null)
  const {
    actions,
    actionLabels,
    bindings,
    editor,
    gotoLine,
    mobilePane,
    openFromTree,
    saveActive,
    saveAll,
    setMobilePane,
    setMonacoReadHandles,
    sideTab,
    setSideTab,
  } = workbench
  const {
    activeFile,
    activePath,
    closeFile,
    deps,
    dirtyCount,
    openFiles,
    pinFile,
    previewPath,
    rootPath,
    setActivePath,
    setDraft,
    treeRefreshToken,
  } = editor

  // A cold open moves `activePath` synchronously but the file only exists in
  // `openFiles` once the async read lands — rendering the empty state in
  // between unmounted Monaco and painted "Open a file" over the pane for a
  // frame, which was the file-switch flicker. Keep the editor mounted under a
  // delayed veil until the new file arrives. The stand-in has to be a file
  // whose model is still retained: an evicted preview tab's model is already
  // disposed, and attaching one blanks the editor.
  const fileLoading = activePath !== null && activeFile === null
  const [lastShownFile, setLastShownFile] = useState<OpenFile | null>(null)
  // Render-adjust (the same pattern `useEdgePanelTransition` relies on): the
  // standby has to be known *during* the render where `activeFile` drops out,
  // so neither a ref read nor an effect can supply it.
  if (activeFile && activeFile.relPath !== lastShownFile?.relPath) {
    setLastShownFile(activeFile)
  }
  const standbyFile =
    openFiles.find((f) => f.relPath === lastShownFile?.relPath) ?? openFiles.at(-1) ?? null
  const shownFile = activeFile ?? (fileLoading ? standbyFile : null)

  const loadingLabel = t("loadingFile", { name: activePath ?? "" })
  // The veil's entrance is delayed ~120ms so a fast read never paints it —
  // otherwise the indicator would itself become the flash it replaced.
  const loadingVeil = fileLoading ? (
    <div
      data-testid="editor-loading"
      role="status"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/60 animate-in fade-in-0 fill-mode-backwards duration-200 [animation-delay:120ms]"
    >
      <Spinner />
      <span className="text-xs text-muted-foreground">{loadingLabel}</span>
    </div>
  ) : null
  const loadingPane = fileLoading ? (
    <div
      data-testid="editor-loading"
      role="status"
      className="flex h-full flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
    >
      <Spinner />
      {loadingLabel}
    </div>
  ) : null

  const editorSelection =
    shownFile && editorSelectionState?.relPath === shownFile.relPath
      ? editorSelectionState.selection
      : undefined
  const diagnostics =
    shownFile && diagnosticsState?.relPath === shownFile.relPath
      ? diagnosticsState.diagnostics
      : null
  const handleDiagnosticsReady = useCallback(
    (relPath: string, next: { monaco: MonacoLike; editor: EditorLike } | null) =>
      setDiagnosticsState({ relPath, diagnostics: next }),
    []
  )

  // Hand Monaco's live handles to the hook so the project-editor opener it
  // registered can answer `readActive`. This mount callback is the only place
  // the raw instances surface; `EditorLike` is the narrow view the diagnostics
  // hook needs, and the same object also satisfies `ReadableMonacoEditor`.
  useEffect(() => {
    setMonacoReadHandles(
      diagnostics
        ? {
            monaco: diagnostics.monaco,
            editor: diagnostics.editor as unknown as ReadableMonacoEditor,
          }
        : null
    )
    return () => setMonacoReadHandles(null)
  }, [diagnostics, setMonacoReadHandles])

  /**
   * Put a file-tree failure where the user will see it.
   *
   * The tree renders a listing failure in place as well, because a toast
   * scrolls away and leaves a folder looking empty. This is the channel for the
   * three that have no row of their own: a create, a rename and a delete each
   * close their dialog, and before this they closed it as if they had worked.
   */
  const reportTreeFailure = useCallback(
    (failure: FileTreeFailure, operation: FileTreeOperation, relPath: string) => {
      toast.error(
        t("treeFailureToast", {
          operation: t(`treeOperation.${operation}`),
          path: relPath || rootPath,
          reason: t(`treeFailure.${failure.kind}`),
        }),
        { description: failure.detail ?? undefined }
      )
    },
    [t, rootPath]
  )

  const fileTree = (
    <ProjectFileTree
      rootPath={rootPath}
      refreshToken={treeRefreshToken}
      activePath={activePath}
      onOpenFile={openFromTree}
      onRenamed={editor.renameOpenFile}
      deps={deps}
      density={layout === "mobile" ? "touch" : "compact"}
      onFailure={reportTreeFailure}
    />
  )
  const searchPanel = (
    <ProjectSearchPanel
      rootPath={rootPath}
      onOpenMatch={gotoLine}
      density={layout === "mobile" ? "touch" : "compact"}
    />
  )

  if (layout === "mobile") {
    const mobileContent =
      mobilePane === "files" ? (
        fileTree
      ) : mobilePane === "search" ? (
        searchPanel
      ) : shownFile ? (
        <div className="relative h-full">
          <LightCodeEditor
            key={shownFile.absolutePath}
            value={shownFile.draftContent}
            language={shownFile.language}
            onChange={(value) => setDraft(shownFile.relPath, value)}
            aria-label={shownFile.relPath}
          />
          {loadingVeil}
        </div>
      ) : (
        (loadingPane ?? (
          <div
            className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
            data-testid={emptyTestId}
          >
            {t("emptyEditor")}
          </div>
        ))
      )

    return (
      <>
        <div className="flex h-full min-h-0 flex-col" data-testid="project-editor-mobile-layout">
          <div
            className={cn(
              "grid shrink-0 border-b bg-background/95 p-1",
              contextWorkbenchVisible ? "grid-cols-4" : "grid-cols-3"
            )}
          >
            <button
              type="button"
              data-testid="project-editor-mobile-files"
              aria-pressed={mobilePane === "files"}
              className={cn(
                "flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2 text-sm",
                mobilePane === "files" ? "bg-accent" : "text-muted-foreground"
              )}
              onClick={() => {
                setSideTab("files")
                setMobilePane("files")
              }}
            >
              <FilesIcon className="size-4" />
              {t("filesTab")}
            </button>
            {contextWorkbenchVisible ? (
              <button
                type="button"
                data-testid="project-editor-mobile-workbench"
                aria-expanded={mobileWorkbenchOpen}
                className="flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground"
                onClick={() => setMobileWorkbenchOpen(true)}
              >
                <PanelRightIcon className="size-4" />
                {t("workbench.mobileTab")}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="project-editor-mobile-search"
              aria-pressed={mobilePane === "search"}
              className={cn(
                "flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2 text-sm",
                mobilePane === "search" ? "bg-accent" : "text-muted-foreground"
              )}
              onClick={() => {
                setSideTab("search")
                setMobilePane("search")
              }}
            >
              <SearchIcon className="size-4" />
              {t("searchTab")}
            </button>
            <button
              type="button"
              data-testid="project-editor-mobile-editor"
              aria-pressed={mobilePane === "editor"}
              className={cn(
                "flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2 text-sm",
                mobilePane === "editor" ? "bg-accent" : "text-muted-foreground"
              )}
              onClick={() => setMobilePane("editor")}
            >
              <CodeIcon className="size-4" />
              {t("editorTab")}
            </button>
          </div>
          <div className="min-h-0 flex-1">{mobileContent}</div>
          {mobilePane === "editor" && activeFile ? (
            <div className="shrink-0 border-t p-2">
              <Button
                type="button"
                className="h-11 w-full gap-2"
                onClick={saveActive}
                data-testid="project-editor-mobile-save"
              >
                <SaveIcon className="size-4" />
                {t("action.save")}
              </Button>
            </div>
          ) : null}
        </div>
        {contextWorkbenchVisible && shownFile ? (
          <ProjectContextWorkbenchMobile
            scopeKey={editor.scopeKey}
            rootPath={rootPath}
            file={shownFile}
            onDraftChange={(content) => setDraft(shownFile.relPath, content)}
            selection={editorSelection}
            diagnostics={diagnostics}
            open={mobileWorkbenchOpen}
            onOpenChange={setMobileWorkbenchOpen}
          />
        ) : null}
      </>
    )
  }

  const sidebar = (
    <ResizablePanel
      id={`${panelIdPrefix}-sidebar`}
      defaultSize={sidebarPosition === "left" ? 24 : 28}
      minSize={sidebarPosition === "left" ? 14 : 18}
      className="min-h-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 border-b">
          <button
            type="button"
            data-testid="left-tab-files"
            className={cn(
              "flex flex-1 items-center justify-center gap-1 py-1 text-xs",
              sideTab === "files" ? "bg-accent" : "text-muted-foreground hover:bg-accent/50"
            )}
            onClick={() => setSideTab("files")}
          >
            <FilesIcon className="size-3.5" />
            {t("filesTab")}
          </button>
          <button
            type="button"
            data-testid="left-tab-search"
            className={cn(
              "flex flex-1 items-center justify-center gap-1 py-1 text-xs",
              sideTab === "search" ? "bg-accent" : "text-muted-foreground hover:bg-accent/50"
            )}
            onClick={() => setSideTab("search")}
          >
            <SearchIcon className="size-3.5" />
            {t("searchTab")}
          </button>
        </div>
        <div className="min-h-0 flex-1">{sideTab === "files" ? fileTree : searchPanel}</div>
      </div>
    </ResizablePanel>
  )

  const editorPane = (
    <ResizablePanel
      id={`${panelIdPrefix}-editor`}
      defaultSize={sidebarPosition === "left" ? 76 : 72}
      minSize={sidebarPosition === "left" ? 30 : 40}
      className="min-h-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        {showTabs ? (
          <ProjectEditorTabs
            files={openFiles}
            activePath={activePath}
            previewPath={previewPath}
            dirtyCount={dirtyCount}
            onSelect={setActivePath}
            onClose={closeFile}
            onPin={pinFile}
            onSaveAll={saveAll}
          />
        ) : null}
        <div className="flex min-h-0 flex-1">
          {shownFile ? (
            <>
              <div className="relative min-w-0 flex-1">
                {/* No `key` — one editor serves every tab. Remounting per file
                    destroyed the Monaco model and its undo stack; the model is
                    swapped through `path` instead. */}
                <ProjectMonaco
                  file={shownFile}
                  projectRoot={rootPath}
                  onChange={(value) => setDraft(shownFile.relPath, value)}
                  actions={actions}
                  actionLabels={actionLabels}
                  bindings={bindings}
                  onSelectionChange={(selection) => {
                    setEditorSelectionState({ relPath: shownFile.relPath, selection })
                    // Caret/selection moves are the other half of "the active
                    // editor changed" — the ref-based read above only covers
                    // which file is open, not where the user is inside it.
                    notifyActiveEditorChanged()
                  }}
                  onDiagnosticsReady={handleDiagnosticsReady}
                />
                {loadingVeil}
              </div>
              {contextWorkbenchVisible ? (
                <ProjectContextWorkbench
                  scopeKey={editor.scopeKey}
                  rootPath={rootPath}
                  file={shownFile}
                  onDraftChange={(content) => setDraft(shownFile.relPath, content)}
                  selection={editorSelection}
                  diagnostics={diagnostics}
                />
              ) : null}
            </>
          ) : (
            (loadingPane ?? (
              <div
                className="flex h-full flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
                data-testid={emptyTestId}
              >
                {t("emptyEditor")}
              </div>
            ))
          )}
        </div>
      </div>
    </ResizablePanel>
  )

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0">
      {sidebarPosition === "left" ? sidebar : editorPane}
      <ResizableHandle withHandle />
      {sidebarPosition === "left" ? editorPane : sidebar}
    </ResizablePanelGroup>
  )
}
