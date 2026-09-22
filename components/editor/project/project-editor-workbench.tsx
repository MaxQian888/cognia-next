"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import {
  CodeIcon,
  FileIcon,
  FilesIcon,
  FolderSearchIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  RotateCcwIcon,
  SaveIcon,
  SearchIcon,
  WrenchIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { LightCodeEditor } from "@/components/editor/light-code-editor"
import { Spinner } from "@/components/ui/spinner"
import { usePanelRef } from "react-resizable-panels"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
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
import { ProjectEditorBreadcrumbs } from "./project-editor-breadcrumbs"
import { ProjectEditorStatusBar } from "./project-editor-status-bar"
import { ProjectEditorTabs } from "./project-editor-tabs"
import { ProjectFileFallback } from "./project-file-fallback"
import type { FileTreeFailure, FileTreeOperation } from "@/lib/files/file-tree-failure"
import { ProjectFileTree } from "./project-file-tree"
import { ProjectMonaco } from "./project-monaco"
import { ProjectQuickOpen } from "./project-quick-open"
import { ProjectSearchPanel } from "./project-search-panel"
import { useProjectEditor, type OpenFile, type UseProjectEditorArgs } from "./use-project-editor"
import { useProjectGitStatus, type ProjectGitStatusDeps } from "./use-project-git-status"
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
  const [quickOpen, setQuickOpen] = useState(false)
  // The panel ref lives here (not in the component) so the ⇧⌘F chord can
  // expand a collapsed sidebar the same way the rail's own buttons do.
  const sidebarPanelRef = usePanelRef()
  const editor = useProjectEditor({ scopeKey, workingDir, followedRoot, deps })
  const {
    activeFile,
    activePath,
    closeFile,
    openFile,
    reopenClosedFile,
    rootPath,
    saveAll,
    saveFile,
    setActivePath,
  } = editor

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

  const cycleTab = useCallback(
    (dir: 1 | -1) => {
      if (openFiles.length < 2 || activePath === null) return
      const index = openFiles.findIndex((f) => f.relPath === activePath)
      if (index === -1) return
      const next = openFiles[(index + dir + openFiles.length) % openFiles.length]
      setActivePath(next.relPath)
    },
    [activePath, openFiles, setActivePath]
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      // ⌘P / Ctrl+P — the file picker. Only plain Cmd/Ctrl: Cmd+Shift+P is
      // conventionally the command palette, which this surface does not have.
      if (key === "p" && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        setQuickOpen(true)
        return
      }
      // Ctrl(+Shift)+Tab — cycle tabs. ⌘Tab is the OS app switcher and must
      // not be swallowed.
      if (key === "tab" && event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        cycleTab(event.shiftKey ? -1 : 1)
        return
      }
      // ⌘⇧] / ⌘⇧[ (or Ctrl+Shift+) — next/previous tab. `event.code` reports
      // the physical key; `event.key` would be the shifted glyph ("}" / "{").
      if (
        event.shiftKey &&
        !event.altKey &&
        (event.code === "BracketRight" || event.code === "BracketLeft")
      ) {
        event.preventDefault()
        cycleTab(event.code === "BracketRight" ? 1 : -1)
        return
      }
      // ⌘⇧T / Ctrl+Shift+T — reopen the most recently closed tab.
      if (key === "t" && event.shiftKey && !event.altKey) {
        event.preventDefault()
        reopenClosedFile()
        return
      }
      // ⇧⌘F / Ctrl+Shift+F — project-wide search. Plain ⌘F is Monaco's
      // find-in-file and reaches the editor before bubbling here.
      if (key === "f" && event.shiftKey && !event.altKey) {
        event.preventDefault()
        setSideTab("search")
        setMobilePane("search")
        sidebarPanelRef.current?.expand()
        return
      }
      // ⌘W / Ctrl+W — close the active tab. With nothing open the chord is
      // left alone so the shell keeps its window-close meaning.
      if (key === "w" && !event.shiftKey && !event.altKey) {
        if (activePath === null) return
        event.preventDefault()
        closeFile(activePath)
        return
      }
      if (key !== "s") return
      event.preventDefault()
      if (event.shiftKey) saveEveryFile()
      else saveActive()
    },
    [activePath, closeFile, cycleTab, reopenClosedFile, saveActive, saveEveryFile, sidebarPanelRef]
  )

  return {
    editor,
    bindings,
    sideTab,
    setSideTab,
    mobilePane,
    setMobilePane,
    sidebarPanelRef,
    quickOpen,
    setQuickOpen,
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
  /** Retain editor state while another dock surface is selected. */
  active?: boolean
  /** Injectable git-status deps (tests); defaults to the real transport. */
  gitDeps?: Partial<ProjectGitStatusDeps>
}

/** Sidebar collapse threshold — the rail alone is 40px wide. */
const RAIL_WIDTH_PX = 40

export function ProjectEditorFileWorkbench({
  workbench,
  sidebarPosition,
  panelIdPrefix,
  showTabs = false,
  showContextWorkbench = true,
  emptyTestId = "editor-empty",
  layout = "split",
  active = true,
  gitDeps,
}: ProjectEditorFileWorkbenchProps) {
  const t = useTranslations("projectEditor")
  const contextWorkbenchVisible = showContextWorkbench
  const [mobileWorkbenchOpen, setMobileWorkbenchOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [revealRequest, setRevealRequest] = useState<{ path: string; nonce: number } | null>(null)
  const [cursor, setCursor] = useState<{
    relPath: string
    lineNumber: number
    column: number
  } | null>(null)
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
    quickOpen,
    saveActive,
    saveAll,
    setMobilePane,
    setMonacoReadHandles,
    setQuickOpen,
    sideTab,
    setSideTab,
    sidebarPanelRef,
  } = workbench
  const {
    activeFile,
    activePath,
    closeAllFiles,
    closeFile,
    closeFilesToRight,
    closeOtherFiles,
    deps,
    dirtyCount,
    moveOpenFile,
    openFiles,
    pinFile,
    previewPath,
    reloadFile,
    reopenClosedFile,
    rootPath,
    setActivePath,
    setDraft,
    treeRefreshToken,
  } = editor

  const { branch, byPath: gitDecorations } = useProjectGitStatus(
    rootPath,
    treeRefreshToken,
    gitDeps
  )

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
  const shownCursor =
    shownFile && cursor?.relPath === shownFile.relPath
      ? { lineNumber: cursor.lineNumber, column: cursor.column }
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

  const copyPath = useCallback(
    (relPath: string, absolute: boolean) => {
      const text = absolute ? joinPath(rootPath, relPath) : relPath
      void navigator.clipboard?.writeText(text)
    },
    [rootPath]
  )

  const revertFile = useCallback(
    (relPath: string) => {
      void reloadFile(relPath).catch((error) =>
        toast.error(t("saveFailed", { error: String(error) }))
      )
    },
    [reloadFile, t]
  )

  const revealInTree = useCallback(
    (relPath: string) => {
      setSideTab("files")
      setMobilePane("files")
      sidebarPanelRef.current?.expand()
      setRevealRequest({ path: relPath, nonce: Date.now() })
    },
    [setMobilePane, setSideTab, sidebarPanelRef]
  )

  const openAnyway = useCallback(() => {
    if (!shownFile) return
    void editor.openFile(shownFile.relPath, { allowLarge: true })
  }, [editor, shownFile])

  const openSearchPane = useCallback(() => {
    setSideTab("search")
    setMobilePane("search")
    sidebarPanelRef.current?.expand()
  }, [setMobilePane, setSideTab, sidebarPanelRef])

  const rootName = useMemo(() => {
    const parts = rootPath.split(/[\\/]/).filter(Boolean)
    return parts.at(-1) ?? rootPath
  }, [rootPath])

  const filesVisible =
    active &&
    (layout === "mobile" ? mobilePane === "files" : sideTab === "files" && !sidebarCollapsed)
  const searchVisible =
    active &&
    (layout === "mobile" ? mobilePane === "search" : sideTab === "search" && !sidebarCollapsed)
  // Selection/caret state belongs to the editor. Reuse these elements until
  // their own inputs change so every caret move does not redraw the tree.
  const fileTree = useMemo(
    () => (
      <ProjectFileTree
        rootPath={rootPath}
        refreshToken={treeRefreshToken}
        activePath={activePath}
        active={filesVisible}
        onOpenFile={openFromTree}
        onRenamed={editor.renameOpenFile}
        deps={deps}
        density={layout === "mobile" ? "touch" : "compact"}
        gitDecorations={gitDecorations}
        onCopyPath={copyPath}
        revealRequest={revealRequest ?? undefined}
        onFailure={reportTreeFailure}
      />
    ),
    [
      rootPath,
      treeRefreshToken,
      activePath,
      filesVisible,
      openFromTree,
      editor.renameOpenFile,
      deps,
      layout,
      gitDecorations,
      copyPath,
      revealRequest,
      reportTreeFailure,
    ]
  )
  const searchPanel = useMemo(
    () => (
      <ProjectSearchPanel
        rootPath={rootPath}
        active={searchVisible}
        onOpenMatch={gotoLine}
        density={layout === "mobile" ? "touch" : "compact"}
      />
    ),
    [rootPath, searchVisible, gotoLine, layout]
  )

  const breadcrumbs = shownFile ? (
    <ProjectEditorBreadcrumbs
      rootPath={rootPath}
      rootName={rootName}
      relPath={shownFile.relPath}
      onOpenFile={openFromTree}
      onRevealDir={revealInTree}
      deps={{ listDir: deps.listDir }}
    />
  ) : null

  const statusBar = shownFile ? (
    <ProjectEditorStatusBar
      file={shownFile}
      cursor={shownCursor}
      selection={editorSelection}
      diagnostics={diagnostics}
      branch={branch}
      density={layout === "mobile" ? "touch" : "compact"}
    />
  ) : null

  const emptyPane = (
    <div
      className="flex h-full flex-1 flex-col items-center justify-center gap-5 p-6"
      data-testid={emptyTestId}
    >
      <div className="flex size-14 items-center justify-center rounded-2xl bg-muted/60">
        <FileIcon className="size-6 text-muted-foreground" />
      </div>
      <p className="text-center text-sm text-muted-foreground">{t("emptyEditor")}</p>
      <div className="flex flex-col gap-0.5">
        <EmptyShortcut
          icon={<FolderSearchIcon className="size-3.5" />}
          label={t("quickOpen.hint")}
          keys="⌘P"
          onClick={() => setQuickOpen(true)}
          testId="editor-empty-quick-open"
        />
        <EmptyShortcut
          icon={<SearchIcon className="size-3.5" />}
          label={t("sidebar.search")}
          keys="⇧⌘F"
          onClick={openSearchPane}
          testId="editor-empty-search"
        />
        <EmptyShortcut
          icon={<RotateCcwIcon className="size-3.5" />}
          label={t("tabs.reopenClosed")}
          keys="⇧⌘T"
          onClick={reopenClosedFile}
          testId="editor-empty-reopen"
        />
      </div>
    </div>
  )

  if (layout === "mobile") {
    const mobileEditorContent = shownFile ? (
      <div className="flex h-full flex-col">
        {breadcrumbs}
        <div className="relative min-h-0 flex-1">
          {shownFile.blocked ? (
            <ProjectFileFallback
              file={shownFile}
              rootPath={rootPath}
              onOpenAnyway={openAnyway}
              readFileBase64={deps.readFileBase64}
              density="touch"
            />
          ) : (
            <LightCodeEditor
              key={shownFile.absolutePath}
              value={shownFile.draftContent}
              language={shownFile.language}
              onChange={(value) => setDraft(shownFile.relPath, value)}
              aria-label={shownFile.relPath}
            />
          )}
          {loadingVeil}
        </div>
        {statusBar}
      </div>
    ) : (
      (loadingPane ?? emptyPane)
    )

    const mobileNavButton = (
      pane: "files" | "search" | "editor",
      icon: ReactNode,
      label: string,
      testId: string,
      badge?: number
    ) => (
      <button
        key={pane}
        type="button"
        data-testid={testId}
        aria-pressed={mobilePane === pane}
        className={cn(
          "relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]",
          mobilePane === pane
            ? "text-foreground before:absolute before:top-0 before:inset-x-3 before:h-0.5 before:rounded-full before:bg-primary"
            : "text-muted-foreground"
        )}
        onClick={() => {
          if (pane !== "editor") setSideTab(pane)
          setMobilePane(pane)
        }}
      >
        <span className="relative">
          {icon}
          {badge ? (
            <span className="absolute -top-1 -right-2 flex size-3.5 items-center justify-center rounded-full bg-amber-500 text-[9px] font-semibold text-white">
              {badge > 9 ? "9+" : badge}
            </span>
          ) : null}
        </span>
        {label}
      </button>
    )

    return (
      <>
        <div className="flex h-full min-h-0 flex-col" data-testid="project-editor-mobile-layout">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <div className="h-full" hidden={mobilePane !== "files"}>
              {fileTree}
            </div>
            <div className="h-full" hidden={mobilePane !== "search"}>
              {searchPanel}
            </div>
            <div className="h-full" hidden={mobilePane !== "editor"}>
              {mobileEditorContent}
            </div>
          </div>
          <nav
            className="flex shrink-0 items-stretch border-t bg-background/95 pb-[env(safe-area-inset-bottom)]"
            aria-label={t("mobileNav.aria")}
            data-testid="project-editor-mobile-nav"
          >
            {mobileNavButton(
              "files",
              <FilesIcon className="size-5" />,
              t("filesTab"),
              "project-editor-mobile-files"
            )}
            {mobileNavButton(
              "search",
              <SearchIcon className="size-5" />,
              t("searchTab"),
              "project-editor-mobile-search"
            )}
            {mobileNavButton(
              "editor",
              <CodeIcon className="size-5" />,
              t("editorTab"),
              "project-editor-mobile-editor",
              dirtyCount
            )}
            {contextWorkbenchVisible ? (
              <button
                type="button"
                data-testid="project-editor-mobile-workbench"
                aria-expanded={mobileWorkbenchOpen}
                className="relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground"
                onClick={() => setMobileWorkbenchOpen(true)}
              >
                <WrenchIcon className="size-5" />
                {t("workbench.mobileTab")}
              </button>
            ) : null}
            {mobilePane === "editor" && activeFile && !activeFile.blocked ? (
              <button
                type="button"
                data-testid="project-editor-mobile-save"
                className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground"
                onClick={saveActive}
              >
                <SaveIcon className="size-5" />
                {t("action.save")}
              </button>
            ) : null}
          </nav>
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
        <ProjectQuickOpen
          rootPath={rootPath}
          open={quickOpen}
          onOpenChange={setQuickOpen}
          openPaths={openFiles.map((f) => f.relPath)}
          onOpenFile={(relPath) => {
            setQuickOpen(false)
            openFromTree(relPath)
          }}
        />
      </>
    )
  }

  const railButtonClass = (active: boolean) =>
    cn(
      "relative flex size-8 items-center justify-center rounded-md transition-colors",
      active
        ? "bg-accent text-foreground"
        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      // VS Code's signature: a short accent strip on the rail's outer edge
      // marks the view that owns the open panel.
      active &&
        (sidebarPosition === "left"
          ? "before:absolute before:top-1 before:bottom-1 before:-left-1 before:w-0.5 before:rounded-full before:bg-primary"
          : "before:absolute before:top-1 before:bottom-1 before:-right-1 before:w-0.5 before:rounded-full before:bg-primary")
    )
  const railTooltipSide = sidebarPosition === "left" ? "right" : "left"

  const selectSideTab = (tab: "files" | "search") => {
    if (sideTab === tab && !sidebarCollapsed) {
      sidebarPanelRef.current?.collapse()
      return
    }
    setSideTab(tab)
    sidebarPanelRef.current?.expand()
  }

  const toggleSidebar = () => {
    const panel = sidebarPanelRef.current
    if (!panel) return
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }

  const rail = (
    // The app root mounts a provider already; nesting one here keeps the rail
    // self-sufficient when the workbench renders without it (tests, embeds).
    <TooltipProvider delayDuration={400}>
      <div
        className={cn(
          "flex w-10 shrink-0 flex-col items-center gap-1 py-2",
          sidebarPosition === "left" ? "border-r" : "border-l",
          "bg-muted/30"
        )}
        role="toolbar"
        aria-label={t("sidebar.aria")}
        aria-orientation="vertical"
        data-testid="project-editor-activity-rail"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="left-tab-files"
              aria-label={t("filesTab")}
              aria-pressed={sideTab === "files" && !sidebarCollapsed}
              className={railButtonClass(sideTab === "files" && !sidebarCollapsed)}
              onClick={() => selectSideTab("files")}
            >
              <FilesIcon className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side={railTooltipSide}>{t("filesTab")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="left-tab-search"
              aria-label={t("searchTab")}
              aria-pressed={sideTab === "search" && !sidebarCollapsed}
              className={railButtonClass(sideTab === "search" && !sidebarCollapsed)}
              onClick={() => selectSideTab("search")}
            >
              <SearchIcon className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side={railTooltipSide}>{t("searchTab")}</TooltipContent>
        </Tooltip>
        <div className="mt-auto flex flex-col items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={railButtonClass(false)}
                onClick={() => setQuickOpen(true)}
                data-testid="rail-quick-open"
                aria-label={t("quickOpen.hint")}
              >
                <FolderSearchIcon className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side={railTooltipSide}>{t("quickOpen.hint")} ⌘P</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={railButtonClass(false)}
                onClick={toggleSidebar}
                data-testid="rail-toggle-sidebar"
                aria-label={sidebarCollapsed ? t("sidebar.expand") : t("sidebar.collapse")}
                aria-expanded={!sidebarCollapsed}
              >
                {sidebarCollapsed ? (
                  sidebarPosition === "left" ? (
                    <PanelLeftOpenIcon className="size-4" />
                  ) : (
                    <PanelRightOpenIcon className="size-4" />
                  )
                ) : sidebarPosition === "left" ? (
                  <PanelLeftCloseIcon className="size-4" />
                ) : (
                  <PanelRightCloseIcon className="size-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side={railTooltipSide}>
              {sidebarCollapsed ? t("sidebar.expand") : t("sidebar.collapse")}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  )

  const sidebar = (
    <ResizablePanel
      id={`${panelIdPrefix}-sidebar`}
      collapsible
      collapsedSize={`${RAIL_WIDTH_PX}px`}
      minSize="160px"
      defaultSize="25%"
      maxSize="45%"
      panelRef={sidebarPanelRef}
      onResize={(size) => setSidebarCollapsed(size.inPixels <= RAIL_WIDTH_PX + 8)}
      className="min-h-0"
    >
      <div className="flex h-full min-h-0">
        {sidebarPosition === "left" ? rail : null}
        <div
          className={cn("flex min-w-0 flex-1 flex-col", sidebarCollapsed && "hidden")}
          data-testid="project-editor-sidebar-content"
        >
          <div className="flex h-9 shrink-0 items-center border-b px-3">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {sideTab === "files" ? t("sidebar.explorer") : t("sidebar.search")}
            </span>
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <div className="h-full" hidden={!filesVisible}>
              {fileTree}
            </div>
            <div className="h-full" hidden={!searchVisible}>
              {searchPanel}
            </div>
          </div>
        </div>
        {sidebarPosition === "right" ? rail : null}
      </div>
    </ResizablePanel>
  )

  const editorPane = (
    <ResizablePanel
      id={`${panelIdPrefix}-editor`}
      minSize="30%"
      className="min-h-0 min-w-0 overflow-hidden"
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
            onMove={moveOpenFile}
            onCloseOthers={closeOtherFiles}
            onCloseToRight={closeFilesToRight}
            onCloseAll={closeAllFiles}
            onCopyPath={copyPath}
            onRevert={revertFile}
          />
        ) : null}
        {breadcrumbs}
        <div className="flex min-h-0 flex-1">
          {shownFile ? (
            <>
              <div className="relative min-w-0 flex-1">
                {shownFile.blocked ? (
                  <ProjectFileFallback
                    file={shownFile}
                    rootPath={rootPath}
                    onOpenAnyway={openAnyway}
                    readFileBase64={deps.readFileBase64}
                  />
                ) : (
                  /* No `key` — one editor serves every tab. Remounting per file
                     destroyed the Monaco model and its undo stack; the model is
                     swapped through `path` instead. */
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
                    onCursorChange={(position) =>
                      setCursor(
                        position
                          ? {
                              relPath: shownFile.relPath,
                              lineNumber: position.lineNumber,
                              column: position.column,
                            }
                          : null
                      )
                    }
                    onDiagnosticsReady={handleDiagnosticsReady}
                  />
                )}
                {loadingVeil}
              </div>
              {contextWorkbenchVisible && !shownFile.blocked ? (
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
            (loadingPane ?? emptyPane)
          )}
        </div>
        {statusBar}
      </div>
    </ResizablePanel>
  )

  return (
    <>
      <ResizablePanelGroup
        orientation="horizontal"
        className="h-full min-h-0 min-w-0 overflow-hidden"
      >
        {sidebarPosition === "left" ? sidebar : editorPane}
        <ResizableHandle withHandle />
        {sidebarPosition === "left" ? editorPane : sidebar}
      </ResizablePanelGroup>
      <ProjectQuickOpen
        rootPath={rootPath}
        open={quickOpen}
        onOpenChange={setQuickOpen}
        openPaths={openFiles.map((f) => f.relPath)}
        onOpenFile={(relPath) => {
          setQuickOpen(false)
          openFromTree(relPath)
        }}
      />
    </>
  )
}

/**
 * One row of the empty-state shortcut panel — icon + command label on the
 * left, key glyphs on the right, the whole row a button so the hint is also
 * the action.
 */
function EmptyShortcut({
  icon,
  label,
  keys,
  onClick,
  testId,
}: {
  icon: ReactNode
  label: string
  keys: string
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      className="flex w-56 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      onClick={onClick}
      data-testid={testId}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      <kbd className="rounded border bg-muted/60 px-1 py-px font-mono text-[10px] leading-tight">
        {keys}
      </kbd>
    </button>
  )
}
