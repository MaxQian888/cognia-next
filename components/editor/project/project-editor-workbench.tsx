"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { CodeIcon, FilesIcon, PanelRightIcon, SaveIcon, SearchIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { LightCodeEditor } from "@/components/editor/light-code-editor"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import type { EditorActionDef } from "@/lib/editor-workbench/register-editor-actions"
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
import { ProjectFileTree } from "./project-file-tree"
import { ProjectMonaco } from "./project-monaco"
import { ProjectSearchPanel } from "./project-search-panel"
import { useProjectEditor, type UseProjectEditorArgs } from "./use-project-editor"
import { ProjectContextWorkbench, ProjectContextWorkbenchMobile } from "./project-context-workbench"
import { useContextWorkbenchSurfaceFlag } from "@/hooks/context-workbench/use-context-workbench-surface-flag"
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
  deps,
  beforeOpen,
  registerProjectOpener = true,
}: UseProjectEditorWorkbenchArgs) {
  const t = useTranslations("projectEditor")
  const bindings = useKeybindingStore((state) => state.bindings)
  const [sideTab, setSideTab] = useState<"files" | "search">("files")
  const [mobilePane, setMobilePane] = useState<"files" | "search" | "editor">("files")
  const editor = useProjectEditor({ scopeKey, workingDir, deps })
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
  const workbenchEnabled = useContextWorkbenchSurfaceFlag("project")
  const contextWorkbenchVisible = workbenchEnabled && showContextWorkbench
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
    rootPath,
    setActivePath,
    setDraft,
    treeRefreshToken,
  } = editor
  const editorSelection =
    activeFile && editorSelectionState?.relPath === activeFile.relPath
      ? editorSelectionState.selection
      : undefined
  const diagnostics =
    activeFile && diagnosticsState?.relPath === activeFile.relPath
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

  const fileTree = (
    <ProjectFileTree
      rootPath={rootPath}
      refreshToken={treeRefreshToken}
      activePath={activePath}
      onOpenFile={gotoLine}
      onRenamed={editor.renameOpenFile}
      deps={deps}
      density={layout === "mobile" ? "touch" : "compact"}
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
      ) : activeFile ? (
        <LightCodeEditor
          key={activeFile.absolutePath}
          value={activeFile.draftContent}
          language={activeFile.language}
          onChange={(value) => setDraft(activeFile.relPath, value)}
          aria-label={activeFile.relPath}
        />
      ) : (
        <div
          className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
          data-testid={emptyTestId}
        >
          {t("emptyEditor")}
        </div>
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
        {contextWorkbenchVisible && activeFile ? (
          <ProjectContextWorkbenchMobile
            scopeKey={editor.scopeKey}
            rootPath={rootPath}
            file={activeFile}
            onDraftChange={(content) => setDraft(activeFile.relPath, content)}
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
            dirtyCount={dirtyCount}
            onSelect={setActivePath}
            onClose={closeFile}
            onSaveAll={saveAll}
          />
        ) : null}
        <div className="flex min-h-0 flex-1">
          {activeFile ? (
            <>
              <div className="min-w-0 flex-1">
                <ProjectMonaco
                  key={activeFile.absolutePath}
                  file={activeFile}
                  projectRoot={rootPath}
                  onChange={(value) => setDraft(activeFile.relPath, value)}
                  actions={actions}
                  actionLabels={actionLabels}
                  bindings={bindings}
                  onSelectionChange={(selection) => {
                    setEditorSelectionState({ relPath: activeFile.relPath, selection })
                    // Caret/selection moves are the other half of "the active
                    // editor changed" — the ref-based read above only covers
                    // which file is open, not where the user is inside it.
                    notifyActiveEditorChanged()
                  }}
                  onDiagnosticsReady={handleDiagnosticsReady}
                />
              </div>
              {contextWorkbenchVisible ? (
                <ProjectContextWorkbench
                  scopeKey={editor.scopeKey}
                  rootPath={rootPath}
                  file={activeFile}
                  onDraftChange={(content) => setDraft(activeFile.relPath, content)}
                  selection={editorSelection}
                  diagnostics={diagnostics}
                />
              ) : null}
            </>
          ) : (
            <div
              className="flex h-full flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
              data-testid={emptyTestId}
            >
              {t("emptyEditor")}
            </div>
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
