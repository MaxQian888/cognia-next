"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import {
  AlertTriangleIcon,
  CodeIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FilesIcon,
  FolderSearchIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  PanelLeftOpenIcon,
  RotateCcwIcon,
  SaveIcon,
  SearchIcon,
  TerminalIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { LightCodeEditor } from "@/components/editor/light-code-editor"
import { DiffViewer } from "@/components/source-control/diff-viewer"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { useProjectEditorSessionStore } from "@/stores/editor/project-editor-session-store"
import { armProjectEditorGoto, PROJECT_EDITOR_GOTO_EVENT } from "./editor-events"
import { ProjectEditorBreadcrumbs } from "./project-editor-breadcrumbs"
import { ProjectFilePreviewPanel } from "./project-file-preview-panel"
import { resolveFileViewer } from "@/lib/file-viewer/registry"
import { extensionOf } from "@/lib/file-viewer/probe"
import { ProjectEditorStatusBar } from "./project-editor-status-bar"
import { EDITOR_TAB_DRAG_MIME, ProjectEditorTabs } from "./project-editor-tabs"
import { ProjectFileFallback } from "./project-file-fallback"
import { projectEditorGotoExtension } from "./light-editor-goto"
import type { FileTreeFailure, FileTreeOperation } from "@/lib/files/file-tree-failure"
import { ProjectFileTree } from "./project-file-tree"
import { ProjectMonaco } from "./project-monaco"
import {
  ProjectQuickOpen,
  type ProjectQuickOpenDeps,
  type QuickOpenCommand,
} from "./project-quick-open"
import { ProjectSearchPanel, type ProjectSearchDeps } from "./project-search-panel"
import {
  buildFileContextSelection,
  buildFolderContextSelection,
  buildProblemContextSelection,
  buildProblemsContextSelection,
} from "./file-chat-context"
import type { WorkbenchMarker } from "./project-problems-panel"
import {
  useProjectEditor,
  type OpenFile,
  type ProjectEditorConfirmRequest,
  type ProjectEditorConfirmVerdict,
  type UseProjectEditorArgs,
} from "./use-project-editor"
import { useProjectGitStatus, type ProjectGitStatusDeps } from "./use-project-git-status"
import { useMonacoTsProject } from "./use-monaco-ts-project"
import { ProjectProblemsPanel } from "./project-problems-panel"
import { ProjectContextWorkbench, ProjectContextWorkbenchMobile } from "./project-context-workbench"
import type { ContextPanelMode, TextSelectionCoordinates } from "@/types/context-workbench"
import {
  CONTEXT_WORKBENCH_DEFAULT_WIDTH,
  CONTEXT_WORKBENCH_MIN_WIDTH,
} from "@/stores/context-workbench/context-workbench-store"
import { WORKBENCH_RAIL_WIDTH_PX } from "@/types/shell/workbench-rail"
import { useElementWidth } from "@/hooks/use-element-width"
import type { EditorLike, MonacoLike } from "@/hooks/use-monaco-markers"
import { useChatStore } from "@/stores/chat"
import type { FileSelectionRef } from "@/types/artifact/artifact"
import { fileUriToPath } from "@/lib/files/path-uri"
import { revealInExplorer } from "@/lib/tauri/opener"
import { loadConfiguredMonaco } from "@/lib/canvas/monaco-loader"
import { isTauri } from "@/lib/platform/detect"
import { claimNativeMenuAction } from "@/lib/desktop/menu-focus-claims"

export type ProjectEditorWorkbenchLayout = "split" | "mobile"

interface UseProjectEditorWorkbenchArgs extends UseProjectEditorArgs {
  beforeOpen?: () => void
  registerProjectOpener?: boolean
  /**
   * `split` is the desktop workbench (sidebar, Monaco groups, secondary
   * sidebar); `mobile` is the phone pane flow over CodeMirror. The keyboard
   * layer and the command list need it — a chord for a surface that is not
   * mounted (a second group, the sidebar, the Problems panel) would otherwise
   * silently change hidden state — so it lives on the controller rather than
   * on the component alone.
   */
  layout?: ProjectEditorWorkbenchLayout
}

/**
 * Native-menu accelerators the workbench also answers to (see
 * `lib/desktop/menu-focus-claims.ts`): under Tauri these chords go to the
 * native menu, so the keydown only stamps a claim and the menu router runs
 * the workbench action.
 */
type NativeMenuChord = "command-palette" | "toggle-sidebar" | "go-inbox" | "go-workflows"

/** The live Monaco handles a read needs, as ProjectMonaco hands them over. */
export interface MonacoReadHandles {
  monaco: MonacoLike
  editor: ReadableMonacoEditor
}

/**
 * The mutable slice of a live model the status bar writes through —
 * indentation, line endings and language mode are model-level facts in
 * Monaco. Everything is optional: a handle missing a method just makes the
 * action a no-op rather than a crash.
 */
interface MutableMonacoModel {
  updateOptions?(options: { tabSize?: number; insertSpaces?: boolean }): void
  getOptions?(): { tabSize?: number; insertSpaces?: boolean } | undefined
  setEOL?(eol: number): void
  getEOL?(): string
}

export function useProjectEditorWorkbench({
  scopeKey,
  workingDir,
  followedRoot,
  deps,
  beforeOpen,
  registerProjectOpener = true,
  layout = "split",
}: UseProjectEditorWorkbenchArgs) {
  const t = useTranslations("projectEditor")
  const mobile = layout === "mobile"
  const bindings = useKeybindingStore((state) => state.bindings)
  const [sideTab, setSideTab] = useState<"files" | "search">("files")
  const [mobilePane, setMobilePane] = useState<"files" | "search" | "editor">("files")
  const [quickOpen, setQuickOpen] = useState(false)
  // The panel ref lives here (not in the component) so the ⇧⌘F chord can
  // expand a collapsed sidebar the same way the rail's own buttons do.
  const sidebarPanelRef = usePanelRef()
  // Explorer reveal lives at hook level: the palette's "reveal active file"
  // command and gotoLine's soft reveal need it, not just the component.
  const [revealRequest, setRevealRequest] = useState<{ path: string; nonce: number } | null>(null)
  const revealInTree = useCallback(
    (relPath: string) => {
      setSideTab("files")
      setMobilePane("files")
      sidebarPanelRef.current?.expand()
      setRevealRequest({ path: relPath, nonce: Date.now() })
    },
    [sidebarPanelRef]
  )
  /**
   * Reveal only when the explorer is already on screen — the way VS Code
   * scrolls the tree to a navigated-to file without yanking the sidebar out
   * from under whatever panel the user is in.
   */
  const softRevealInTree = useCallback(
    (relPath: string) => {
      if (sideTab !== "files") return
      setRevealRequest({ path: relPath, nonce: Date.now() })
    },
    [sideTab]
  )

  // Destructive gates (dirty close, overwrite-on-save, revert) surface as an
  // AlertDialog rendered by the workbench component — `window.confirm` blocks
  // the main thread and looks nothing like the app. The resolver ref lets the
  // answer arrive after this callback returned.
  const [confirmRequest, setConfirmRequest] = useState<ProjectEditorConfirmRequest | null>(null)
  const confirmResolveRef = useRef<((v: ProjectEditorConfirmVerdict) => void) | null>(null)
  const confirm = useCallback(
    (request: ProjectEditorConfirmRequest): Promise<ProjectEditorConfirmVerdict> => {
      // A second prompt supersedes the first — answer the stale one "cancel"
      // so its caller's destructive path is refused rather than left hanging.
      confirmResolveRef.current?.("cancel")
      return new Promise<ProjectEditorConfirmVerdict>((resolve) => {
        confirmResolveRef.current = resolve
        setConfirmRequest(request)
      })
    },
    []
  )
  const resolveConfirm = useCallback((verdict: ProjectEditorConfirmVerdict) => {
    const resolve = confirmResolveRef.current
    confirmResolveRef.current = null
    setConfirmRequest(null)
    resolve?.(verdict)
  }, [])

  const editor = useProjectEditor({ scopeKey, workingDir, followedRoot, deps, confirm })
  const {
    activeFile,
    activePath,
    closeFile,
    isPathOpen,
    openFile,
    openFiles,
    reopenClosedFile,
    rootKey,
    rootPath,
    sessionRestored,
    saveAll,
    saveFile,
    setActivePath,
  } = editor

  // ---- editor groups (VS Code-style split) ---------------------------------
  // `openFiles` stays the single document list; group membership is a set of
  // relPaths. `activePath` always mirrors the *focused* group's selection —
  // the reconcile effect below enforces that invariant no matter which door a
  // close/open/focus change came through.
  const [focusedGroup, setFocusedGroup] = useState<0 | 1>(0)
  const [splitTabs, setSplitTabs] = useState<string[]>([])
  const [groupActive, setGroupActive] = useState<[string | null, string | null]>([null, null])
  const [minimapEnabled, setMinimapEnabled] = useState(true)
  const [quickOpenSeed, setQuickOpenSeed] = useState<{ text: string } | null>(null)
  // Rich preview (markdown/html/json) renders as an overlay in place of the
  // text editor for that tab — VS Code's per-editor preview. Monaco stays
  // mounted underneath, so cursor/scroll survive the toggle.
  const [previewTabs, setPreviewTabs] = useState<string[]>([])
  // Per-model word wrap, VS Code's `EditorOption.wordWrap` semantics — ⌥Z
  // flips only the focused editor, not the workbench. Stored as overrides of
  // the layout default (Monaco starts unwrapped, the phone editor wrapped) so
  // a toggle always flips what the user is looking at.
  const [wordWrapOverrides, setWordWrapOverrides] = useState<ReadonlyMap<string, boolean>>(
    new Map()
  )
  const wordWrapDefault = mobile
  const isWordWrapped = useCallback(
    (relPath: string) => wordWrapOverrides.get(relPath) ?? wordWrapDefault,
    [wordWrapDefault, wordWrapOverrides]
  )
  const [editorFontSize, setEditorFontSize] = useState(13)
  // ⌘K prefix chords (⌘K V side preview, ⌘K Z zen): armed by a bare ⌘K
  // keydown, consumed by the next key regardless of modifiers — a foreign
  // editable's keydown still clears it so typing is never swallowed.
  const pendingChordRef = useRef<"k" | null>(null)
  // Zen mode hides every chrome surface around the text — rail, sidebar,
  // tabs, status bar, context workbench. Esc Esc leaves, like VS Code.
  const [zenMode, setZenMode] = useState(false)
  const [problemsVisible, setProblemsVisible] = useState(false)
  const lastEscRef = useRef(0)

  // ---- split-layout session persistence -----------------------------------
  // The editor hook persists rootKey/openPaths/activePath; group membership
  // is workbench state, so it patches the same record — `setSession` merges.
  // Writes are gated on the session existing (editor persists first), on the
  // fields actually changing, and on the restore below having run — a fresh
  // mount otherwise writes the empty initial state over the persisted split
  // before the restore effect can consume it.
  const persistedSession = useProjectEditorSessionStore((s) => s.sessions[scopeKey])
  const setEditorSession = useProjectEditorSessionStore((s) => s.setSession)
  const lastSplitPersistedRef = useRef<string | null>(null)
  const restoredSplitRef = useRef(false)
  useEffect(() => {
    if (!rootKey || !sessionRestored || persistedSession?.rootKey !== rootKey) return
    if (!restoredSplitRef.current) return
    const key = JSON.stringify([splitTabs, groupActive, focusedGroup])
    if (key === lastSplitPersistedRef.current) return
    lastSplitPersistedRef.current = key
    setEditorSession(scopeKey, {
      splitPaths: splitTabs,
      groupActivePaths: groupActive,
      focusedGroup,
    })
  }, [
    rootKey,
    sessionRestored,
    persistedSession?.rootKey,
    splitTabs,
    groupActive,
    focusedGroup,
    scopeKey,
    setEditorSession,
  ])

  // One-shot restore, gated on the editor's *completed* session restore —
  // `rootsReady` alone is too early: the editor reopens persisted files in a
  // sequential `await openFile` loop, and only the first call has marked
  // `openPathsRef` by the time sibling effects run. `sessionRestored` flips
  // after the loop, when `isPathOpen` answers for the whole restored set.
  useEffect(() => {
    if (restoredSplitRef.current || !sessionRestored) return
    if (!persistedSession || persistedSession.rootKey !== rootKey) return
    restoredSplitRef.current = true
    // `isPathOpen` alone is the membership oracle — at `sessionRestored`
    // every persisted path is marked (a path whose open then fails is
    // unmarked and the reconcile's `filter(isPathOpen)` drops it). The
    // record's own `openPaths` is no oracle: it is being rewritten live as
    // reads land.
    const split = (persistedSession.splitPaths ?? []).filter(isPathOpen)
    /* eslint-disable react-hooks/set-state-in-effect -- one-shot seed of
       persisted layout; gated like the editor's own session restore. */
    if (split.length > 0) setSplitTabs(split)
    if (persistedSession.groupActivePaths) setGroupActive(persistedSession.groupActivePaths)
    if (persistedSession.focusedGroup === 1 && split.length > 0) setFocusedGroup(1)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [sessionRestored, persistedSession, rootKey, isPathOpen])

  // ---- most-recently-used order -------------------------------------------
  // Ctrl+Tab walks MRU the way VS Code's quick switcher does, and Quick
  // Open's empty query lists editors by recency — one list feeds both.
  const [mruOrder, setMruOrder] = useState<string[]>([])
  const [mruPrevActive, setMruPrevActive] = useState(activePath)
  if (activePath !== mruPrevActive) {
    setMruPrevActive(activePath)
    if (activePath) {
      setMruOrder((prev) =>
        prev[0] === activePath ? prev : [activePath, ...prev.filter((p) => p !== activePath)]
      )
    }
  }
  /** Open relPaths ordered by recency — MRU entries first, never-activated
   *  tabs appended in tab order (a file can be open without ever focusing). */
  const openPathsByRecency = useMemo(() => {
    const members = new Set(openFiles.map((f) => f.relPath))
    const recent = mruOrder.filter((p) => members.has(p))
    const rest = openFiles.map((f) => f.relPath).filter((p) => !recent.includes(p))
    return [...recent, ...rest]
  }, [openFiles, mruOrder])

  const splitSet = useMemo(() => new Set(splitTabs), [splitTabs])
  const primaryFiles = useMemo(
    () => openFiles.filter((f) => !splitSet.has(f.relPath)),
    [openFiles, splitSet]
  )
  const secondaryFiles = useMemo(
    () => openFiles.filter((f) => splitSet.has(f.relPath)),
    [openFiles, splitSet]
  )
  const splitVisible = secondaryFiles.length > 0
  // A group with no tabs ceases to exist, so a stale `focusedGroup === 1`
  // during the reconcile gap must not read as "the second pane is focused".
  const effectiveFocused = splitVisible ? focusedGroup : 0

  // Refs read by async open routing — captures taken before an `await` go
  // stale when a second open interleaves.
  const focusedGroupRef = useRef(focusedGroup)
  const splitTabsRef = useRef(splitTabs)
  useEffect(() => {
    focusedGroupRef.current = focusedGroup
    splitTabsRef.current = splitTabs
  })

  /**
   * Converge group state after any open/close/focus move. Rules:
   *  - closed docs drop out of `splitTabs` (empty group ⇒ focus back to 0)
   *  - `activePath` living in the non-focused group moves focus to it —
   *    `openFile` knows documents, group membership is workbench state
   *  - the focused group's selection mirrors `activePath`; the unfocused
   *    group keeps its remembered tab, repaired to the last member when the
   *    remembered file closed
   * Every setState is guarded so a keystroke through `openFiles` is a no-op.
   */
  useEffect(() => {
    // `isPathOpen` (not `openFiles`) is the membership oracle: `openFile`'s
    // promise resolves a commit before its read lands, and dropping an
    // in-flight path from `splitTabs` here is how a routed open would leak
    // back into group 1.
    const splitArr = splitTabs.filter(isPathOpen)
    const split = new Set(splitArr)
    const g1 = openFiles.filter((f) => !split.has(f.relPath)).map((f) => f.relPath)
    const g2 = openFiles.filter((f) => split.has(f.relPath)).map((f) => f.relPath)

    let focus = g2.length === 0 ? 0 : focusedGroup
    if (activePath && focus === 0 && split.has(activePath)) focus = 1
    else if (activePath && focus === 1 && !split.has(activePath)) focus = 0

    const repair = (p: string | null, members: string[], inSplit: boolean) =>
      p !== null && isPathOpen(p) && split.has(p) === inSplit ? p : (members.at(-1) ?? null)
    const a0 = focus === 0 ? repair(activePath, g1, false) : repair(groupActive[0], g1, false)
    const a1 = focus === 1 ? repair(activePath, g2, true) : repair(groupActive[1], g2, true)
    const want = focus === 0 ? a0 : a1

    /* eslint-disable react-hooks/set-state-in-effect -- convergence, not a
       cascading update: each setter is guarded, and the oracle `isPathOpen`
       reads a ref that is invalid during render anyway, so this cannot move
       to a render-phase adjustment. */
    if (splitArr.length !== splitTabs.length) setSplitTabs(splitArr)
    if (focus !== focusedGroup) setFocusedGroup(focus)
    if (a0 !== groupActive[0] || a1 !== groupActive[1]) setGroupActive([a0, a1])
    if (want !== activePath) setActivePath(want)
    // Per-tab editor flags die with their tab — a closed doc must not leave
    // a stale preview overlay or wrap override for a same-named reopen.
    setPreviewTabs((prev) => {
      const live = prev.filter(isPathOpen)
      return live.length === prev.length ? prev : live
    })
    setWordWrapOverrides((prev) => {
      const live = [...prev].filter(([path]) => isPathOpen(path))
      return live.length === prev.size ? prev : new Map(live)
    })
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [activePath, focusedGroup, groupActive, isPathOpen, openFiles, setActivePath, splitTabs])

  /**
   * The single door every user-facing open goes through. `openFile` handles
   * the document lifecycle; this adds group routing — a doc that lives in
   * the split group focuses that group (VS Code's reveal-in-place), a doc
   * opened while group 2 is focused lands there.
   */
  const openInWorkbench = useCallback(
    async (relPath: string, options?: { mode?: EditorTabMode; allowLarge?: boolean }) => {
      // Captured before openFile mutates anything: an already-open doc that
      // lives in group 1 must activate *there* (VS Code's reveal-in-place),
      // not be relocated into the focused split group.
      const wasOpen = isPathOpen(relPath)
      if (options === undefined) await openFile(relPath)
      else await openFile(relPath, options)
      if (splitTabsRef.current.includes(relPath)) {
        if (focusedGroupRef.current !== 1) setFocusedGroup(1)
        setGroupActive((prev) => [prev[0], relPath])
      } else if (focusedGroupRef.current === 1 && !wasOpen) {
        setSplitTabs((prev) => (prev.includes(relPath) ? prev : [...prev, relPath]))
        setGroupActive((prev) => [prev[0], relPath])
      } else {
        if (focusedGroupRef.current !== 0) setFocusedGroup(0)
        setGroupActive((prev) => [relPath, prev[1]])
      }
    },
    [isPathOpen, openFile]
  )

  const focusGroup = useCallback(
    (group: 0 | 1) => {
      // The phone pane flow renders one editor; there is no second group to
      // focus, and no visible way back out of one.
      if (mobile || group === focusedGroup) return
      if (group === 1 && secondaryFiles.length === 0) return
      setFocusedGroup(group)
      const members = group === 1 ? secondaryFiles : primaryFiles
      const remembered = groupActive[group]
      const target =
        remembered && members.some((f) => f.relPath === remembered)
          ? remembered
          : (members.at(-1)?.relPath ?? null)
      setActivePath(target)
    },
    [focusedGroup, groupActive, mobile, primaryFiles, secondaryFiles, setActivePath]
  )

  /** A group's tab strip activating one of its tabs also claims focus. */
  const selectInGroup = useCallback(
    (group: 0 | 1, relPath: string) => {
      setGroupActive((prev) => {
        const next: [string | null, string | null] = [prev[0], prev[1]]
        next[group] = relPath
        return next
      })
      if (group !== focusedGroup) setFocusedGroup(group)
      setActivePath(relPath)
    },
    [focusedGroup, setActivePath]
  )

  /** ⌘\\ — split the focused pane's active editor into the other group. */
  const splitEditor = useCallback(() => {
    // A split made on a phone would only show up — unexplained — the next
    // time the session opens at desktop width.
    if (mobile) return
    const source = focusedGroup
    const target = source === 0 ? 1 : 0
    const current = groupActive[source] ?? activePath
    if (!current) return
    setSplitTabs((prev) =>
      target === 1
        ? prev.includes(current)
          ? prev
          : [...prev, current]
        : prev.filter((p) => p !== current)
    )
    setGroupActive((prev) => {
      const next: [string | null, string | null] = [prev[0], prev[1]]
      next[target] = current
      return next
    })
    setFocusedGroup(target)
    setActivePath(current)
  }, [activePath, focusedGroup, groupActive, mobile, setActivePath])

  /**
   * Move an editor into a specific group — the tab context menu and the
   * cross-group tab drag both land here. VS Code activates the dropped tab
   * in its new group, so focus follows the move.
   */
  const moveToGroup = useCallback(
    (relPath: string, target: 0 | 1) => {
      if (mobile) return
      const current: 0 | 1 = splitTabs.includes(relPath) ? 1 : 0
      if (current === target) return
      setSplitTabs((prev) =>
        target === 1
          ? prev.includes(relPath)
            ? prev
            : [...prev, relPath]
          : prev.filter((p) => p !== relPath)
      )
      setGroupActive((prev) => {
        const next: [string | null, string | null] = [prev[0], prev[1]]
        next[target] = relPath
        return next
      })
      setFocusedGroup(target)
      setActivePath(relPath)
    },
    [mobile, setActivePath, splitTabs]
  )

  /** Tab context menu: send this editor to the other group, focus follows. */
  const moveToOtherGroup = useCallback(
    (relPath: string) => moveToGroup(relPath, splitTabs.includes(relPath) ? 0 : 1),
    [moveToGroup, splitTabs]
  )

  // ---- in-editor rich preview (⌘⇧V / ⌘K V) ---------------------------------
  /** Whether the shared viewer registry can render this file's extension. */
  const canPreview = useCallback(
    (relPath: string) =>
      resolveFileViewer({ extension: extensionOf(relPath), source: "project-preview" }) !== null,
    []
  )

  /** ⌘⇧V — swap the editor for the rendered preview of the same buffer. */
  const togglePreview = useCallback(
    (relPath?: string | null) => {
      const target = relPath ?? activePath
      if (!target || !canPreview(target)) return
      setPreviewTabs((prev) =>
        prev.includes(target) ? prev.filter((p) => p !== target) : [...prev, target]
      )
    },
    [activePath, canPreview]
  )

  /** ⌘K V — preview in the second group, like VS Code's "Open Preview to the
   * Side". The file joins group 2 (the ordinary split path) and its flag
   * turns that group's editor into the rendered preview. */
  const previewToSide = useCallback(() => {
    const relPath = activePath
    // "To the side" needs a second group; on a phone ⇧⌘V previews in place.
    if (mobile || !relPath || !canPreview(relPath)) return
    if (splitTabs.includes(relPath)) {
      setFocusedGroup(1)
      setGroupActive((prev) => [prev[0], relPath])
    } else {
      moveToGroup(relPath, 1)
    }
    setPreviewTabs((prev) => (prev.includes(relPath) ? prev : [...prev, relPath]))
  }, [activePath, canPreview, mobile, moveToGroup, splitTabs])

  /** ⌥Z — word wrap for the focused model only (per-model, like VS Code). */
  const toggleWordWrap = useCallback(() => {
    const relPath = activePath
    if (!relPath) return
    setWordWrapOverrides((prev) => {
      const next = new Map(prev)
      next.set(relPath, !(prev.get(relPath) ?? wordWrapDefault))
      return next
    })
  }, [activePath, wordWrapDefault])

  /** ⌘= / ⌘- / ⌘0 — editor font zoom (independent of the page zoom). */
  const zoomEditorFont = useCallback((delta: number | "reset") => {
    setEditorFontSize((v) => (delta === "reset" ? 13 : Math.min(30, Math.max(8, v + delta))))
  }, [])

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
  const editorStateRef = useRef({ rootPath, activePath, openFiles })
  useEffect(() => {
    editorStateRef.current = { rootPath, activePath, openFiles }
  }, [activePath, openFiles, rootPath])

  // Announce selection/open-set moves so `ctx.editor.onDidChangeActiveEditor`
  // subscribers re-read. `openFiles` gets a new identity on every keystroke —
  // keying the notification on the *paths* keeps draft edits from firing an
  // event whose contract is "the active editor changed", not "content did".
  const openPathsKey = openFiles.map((f) => f.relPath).join("\n")
  useEffect(() => {
    notifyActiveEditorChanged()
  }, [activePath, openPathsKey, rootPath])

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
      void openInWorkbench(relPath, options)
    },
    [beforeOpen, openInWorkbench]
  )

  const gotoLine = useCallback(
    (relPath: string, line?: number, column?: number) => {
      beforeOpen?.()
      setMobilePane("editor")
      void openInWorkbench(relPath).then(() => {
        // A deliberate jump keeps the explorer in sync — VS Code reveals the
        // file you navigated to when the tree is on screen.
        softRevealInTree(relPath)
        if (line === undefined) return
        // Arm before dispatching: on a cold open the event fires while
        // Monaco is still loading, so the live listener misses it — the
        // editor drains the armed request the moment it mounts.
        armProjectEditorGoto({ relPath, line, column: column ?? 1 })
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent(PROJECT_EDITOR_GOTO_EVENT, {
              detail: { relPath, line, column: column ?? 1 },
            })
          )
        }, 0)
      })
    },
    [beforeOpen, openInWorkbench, softRevealInTree]
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
      // `force`: the bridge's contract is "the agent sees the buffer the user
      // is looking at" — an interactive confirm would just hang the call.
      await saveAll({ force: true })
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

  /**
   * Revert = reload from disk. A dirty tab's draft is destroyed by the
   * reload, so the hook-level confirm gates it; a clean tab just refreshes.
   * Returned on the controller so hosts that wire the tab strip themselves
   * (the dock) share the same guarded path.
   */
  const revertFile = useCallback(
    (relPath: string) => {
      const reload = () =>
        editor
          .reloadFile(relPath)
          .catch((error) => toast.error(t("saveFailed", { error: String(error) })))
      const verdict = editor.confirmDiscardDraft(relPath)
      // A string verdict (clean tab, or a sync confirm) reloads immediately;
      // a host dialog's promise defers the reload until the user answers.
      // `=== true` keeps boolean-returning stubs working.
      if (verdict === "confirm" || (verdict as unknown) === true) void reload()
      else if (typeof verdict === "object" && verdict !== null)
        void verdict.then((v) => {
          if (v === "confirm") void reload()
        })
    },
    [editor, t]
  )

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
    (dir: 1 | -1, order: "tab" | "mru" = "tab") => {
      // Cycling is scoped to the focused group either way; what differs is
      // the walk order — Ctrl+Tab is VS Code's quick-switcher MRU, the
      // ⌘⇧[ ] chords walk the strip left/right like nextEditorInGroup. The
      // phone layout has one strip listing every open file, so it cycles all.
      const files = mobile ? openFiles : effectiveFocused === 1 ? secondaryFiles : primaryFiles
      if (files.length < 2) return
      const memberPaths = new Set(files.map((f) => f.relPath))
      const sequence =
        order === "mru"
          ? [
              ...mruOrder.filter((p) => memberPaths.has(p)),
              // Never-activated members still cycle — appended in tab order.
              ...files.map((f) => f.relPath).filter((p) => !mruOrder.includes(p)),
            ]
          : files.map((f) => f.relPath)
      if (sequence.length < 2) return
      const current = mobile ? activePath : (groupActive[effectiveFocused] ?? activePath)
      const index = current === null ? -1 : sequence.indexOf(current)
      if (index === -1) return
      const next = sequence[(index + dir + sequence.length) % sequence.length]
      if (!mobile) {
        setGroupActive((prev) => {
          const next2: [string | null, string | null] = [prev[0], prev[1]]
          next2[effectiveFocused] = next
          return next2
        })
      }
      setActivePath(next)
    },
    [
      activePath,
      effectiveFocused,
      groupActive,
      mobile,
      mruOrder,
      openFiles,
      primaryFiles,
      secondaryFiles,
      setActivePath,
    ]
  )

  /** Open Quick Open seeded with a mode prefix: "" files, ">" commands, "@" symbols. */
  const openQuickOpen = useCallback((text: "" | ">" | "@") => {
    // A fresh seed object re-applies even when the palette is already up.
    setQuickOpenSeed({ text })
    setQuickOpen(true)
  }, [])

  /** ⌘B — collapse the sidebar to its rail, or bring it back. */
  const toggleSidebar = useCallback(() => {
    const panel = sidebarPanelRef.current
    if (!panel) return
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }, [sidebarPanelRef])

  /** ⌘1 / ⌘2 — VS Code focuses the group, and ⌘2 creates it when missing. */
  const focusOrCreateGroup = useCallback(
    (group: 0 | 1) => {
      if (group === 1 && !splitVisible) splitEditor()
      else focusGroup(group)
    },
    [focusGroup, splitEditor, splitVisible]
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Editable elements outside Monaco (a tree rename input, the search
      // box) keep their own keys — ⌘W in a rename field must not close the
      // tab behind it. Monaco's hidden textarea is the exception: it IS the
      // editor, and swallowing its chords would kill ⌘S/⌘W on the main path.
      const target = event.target
      const key = event.key.toLowerCase()
      // Consume a pending ⌘K prefix on ANY next key — including one typed
      // into a foreign editable, which clears the chord and types normally.
      const pendingChord = pendingChordRef.current
      pendingChordRef.current = null
      if (
        target instanceof HTMLElement &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target.isContentEditable) &&
        !target.closest(".monaco-editor")
      ) {
        return
      }
      /**
       * The chord is the workbench's. `stopPropagation` matters as much as
       * `preventDefault`: the app-wide shortcut dispatcher listens on
       * `window`, and several of these chords are app shortcuts too (⌘K is
       * the global palette, ⌘1/⌘2 reveal workbench activities, ⌘=/⌘-/⌘0
       * zoom the page) — without it one keystroke would do both.
       */
      const consume = () => {
        event.preventDefault()
        event.stopPropagation()
      }
      /**
       * A chord that is also a native-menu accelerator under Tauri. There the
       * menu owns the keystroke: stamp a claim for the router to take (no
       * `preventDefault`, which could keep the menu from ever seeing it) and
       * let it run the workbench action. The web shell has no native menu.
       */
      const menuChord = (chord: NativeMenuChord, run: () => void) => {
        event.stopPropagation()
        if (isTauri()) {
          claimNativeMenuAction(chord, run)
          return
        }
        event.preventDefault()
        run()
      }
      // ⌘K V / ⌘K Z — the second stroke of a chord arrives with no
      // modifiers; it must complete before the modifier checks below. Inside
      // Monaco the same chords are editor keybindings (Monaco owns ⌘K).
      if (pendingChord === "k" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (key === "v") {
          consume()
          previewToSide()
          return
        }
        if (key === "z") {
          consume()
          setZenMode((v) => !v)
          return
        }
      }
      // Esc Esc — leave zen mode. A lone Escape belongs to whatever Monaco
      // just closed (find widget, suggestion), so it is never swallowed;
      // the double-tap inside 500ms is the exit.
      if (key === "escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (zenMode) {
          const now = Date.now()
          if (now - lastEscRef.current < 500) {
            consume()
            setZenMode(false)
          }
          lastEscRef.current = now
        }
        return
      }
      // ⌥Z — toggle word wrap on the focused model. `event.code` because
      // macOS Option turns the letter into "Ω".
      if (event.altKey && !event.metaKey && !event.ctrlKey && event.code === "KeyZ") {
        consume()
        toggleWordWrap()
        return
      }
      if (!(event.metaKey || event.ctrlKey)) return
      // ⌘⇧P / Ctrl+Shift+P — command palette: quick open seeded with ">".
      if (key === "p" && event.shiftKey && !event.altKey) {
        menuChord("command-palette", () => openQuickOpen(">"))
        return
      }
      // ⌘P / Ctrl+P — the file picker.
      if (key === "p" && !event.shiftKey && !event.altKey) {
        consume()
        openQuickOpen("")
        return
      }
      // ⌘⇧O / Ctrl+Shift+O — Go to Symbol in the active editor (`@` mode).
      if (key === "o" && event.shiftKey && !event.altKey) {
        consume()
        openQuickOpen("@")
        return
      }
      // ⌘⇧T / Ctrl+Shift+T — reopen the most recently closed tab.
      if (key === "t" && event.shiftKey && !event.altKey) {
        consume()
        reopenClosedFile()
        return
      }
      // ⇧⌘F / Ctrl+Shift+F — project-wide search. Plain ⌘F is Monaco's
      // find-in-file and reaches the editor before bubbling here.
      if (key === "f" && event.shiftKey && !event.altKey) {
        consume()
        setSideTab("search")
        setMobilePane("search")
        sidebarPanelRef.current?.expand()
        return
      }
      // Ctrl(+Shift)+Tab — cycle tabs in MRU order, like VS Code's quick
      // switcher. ⌘Tab is the OS app switcher and must not be swallowed.
      if (key === "tab" && event.ctrlKey && !event.metaKey) {
        consume()
        cycleTab(event.shiftKey ? -1 : 1, "mru")
        return
      }
      // ⌘⇧] / ⌘⇧[ (or Ctrl+Shift+) — next/previous tab. `event.code` reports
      // the physical key; `event.key` would be the shifted glyph ("}" / "{").
      if (
        event.shiftKey &&
        !event.altKey &&
        (event.code === "BracketRight" || event.code === "BracketLeft")
      ) {
        consume()
        cycleTab(event.code === "BracketRight" ? 1 : -1)
        return
      }
      // ⌘⇧V / Ctrl+Shift+V — toggle the rendered preview in place of the
      // editor (markdown/html/json only — the flag is per tab).
      if (key === "v" && event.shiftKey && !event.altKey) {
        consume()
        togglePreview()
        return
      }
      // ⌘= / ⌘- / ⌘0 — editor font zoom. Both glyphs of each key are accepted
      // (⌘⇧= is "+", ⌘⇧- is "_" on US layouts).
      if ((key === "=" || key === "+") && !event.altKey) {
        consume()
        zoomEditorFont(1)
        return
      }
      if ((key === "-" || key === "_") && !event.altKey) {
        consume()
        zoomEditorFont(-1)
        return
      }
      if (key === "0" && !event.shiftKey && !event.altKey) {
        consume()
        zoomEditorFont("reset")
        return
      }
      // ⌘W / Ctrl+W — close the active tab. With nothing open the chord is
      // left alone so the shell keeps its window-close meaning.
      if (key === "w" && !event.shiftKey && !event.altKey) {
        if (activePath === null) return
        consume()
        closeFile(activePath)
        return
      }
      if (key === "s" && !event.altKey) {
        consume()
        if (event.shiftKey) saveEveryFile()
        else saveActive()
        return
      }
      // Everything below drives a surface only the split layout mounts —
      // the sidebar, a second editor group, the Problems panel, zen. On a
      // phone these chords stay with the app instead of changing hidden state.
      if (mobile) return
      // ⌘⇧M / Ctrl+Shift+M — the Problems panel.
      if (key === "m" && event.shiftKey && !event.altKey) {
        consume()
        setProblemsVisible((v) => !v)
        return
      }
      // ⌘\ / Ctrl+\ — split the focused pane's active editor to the other
      // group (moves it, like VS Code's "Split Editor Right").
      if (key === "\\" && !event.shiftKey && !event.altKey) {
        consume()
        splitEditor()
        return
      }
      // ⌘1 / ⌘2 (or Ctrl+) — focus editor group 1 / 2.
      if ((key === "1" || key === "2") && !event.shiftKey && !event.altKey) {
        const group = key === "1" ? 0 : 1
        menuChord(group === 0 ? "go-inbox" : "go-workflows", () => focusOrCreateGroup(group))
        return
      }
      // ⌘K — arm the chord prefix; the next key completes or cancels it.
      if (key === "k" && !event.shiftKey && !event.altKey) {
        consume()
        pendingChordRef.current = "k"
        return
      }
      // ⌘B / Ctrl+B — toggle the sidebar, VS Code's most-used workbench chord.
      if (key === "b" && !event.shiftKey && !event.altKey) {
        menuChord("toggle-sidebar", toggleSidebar)
      }
    },
    [
      activePath,
      closeFile,
      cycleTab,
      focusOrCreateGroup,
      mobile,
      openQuickOpen,
      previewToSide,
      reopenClosedFile,
      saveActive,
      saveEveryFile,
      sidebarPanelRef,
      splitEditor,
      toggleSidebar,
      togglePreview,
      toggleWordWrap,
      zenMode,
      zoomEditorFont,
    ]
  )

  return {
    editor,
    layout,
    bindings,
    sideTab,
    setSideTab,
    mobilePane,
    setMobilePane,
    sidebarPanelRef,
    quickOpen,
    setQuickOpen,
    quickOpenSeed,
    openQuickOpen,
    gotoLine,
    openFromTree,
    saveActive,
    saveAll: saveEveryFile,
    revertFile,
    actionLabels,
    actions,
    onKeyDown,
    setMonacoReadHandles,
    confirmRequest,
    resolveConfirm,
    focusedGroup: effectiveFocused,
    splitVisible,
    primaryFiles,
    secondaryFiles,
    groupActive,
    focusGroup,
    focusOrCreateGroup,
    selectInGroup,
    splitEditor,
    moveToOtherGroup,
    moveToGroup,
    openPathsByRecency,
    minimapEnabled,
    setMinimapEnabled,
    revealRequest,
    revealInTree,
    softRevealInTree,
    toggleSidebar,
    previewTabs,
    togglePreview,
    previewToSide,
    canPreview,
    isWordWrapped,
    toggleWordWrap,
    editorFontSize,
    zoomEditorFont,
    zenMode,
    setZenMode,
    problemsVisible,
    setProblemsVisible,
  }
}

export type ProjectEditorWorkbenchController = ReturnType<typeof useProjectEditorWorkbench>

interface ProjectEditorFileWorkbenchProps {
  workbench: ProjectEditorWorkbenchController
  panelIdPrefix: string
  /** Retain editor state while another dock surface is selected. */
  active?: boolean
  /** Injectable git-status deps (tests); defaults to the real transport. */
  gitDeps?: Partial<ProjectGitStatusDeps>
  /** Injectable content-search deps (tests); defaults to the real transport. */
  searchDeps?: Partial<ProjectSearchDeps>
  /** Injectable walk deps (tests); defaults to the real transport. */
  quickOpenDeps?: Partial<ProjectQuickOpenDeps>
  /**
   * Sink for "Add to Chat" actions (tree/tab/editor-selection/problems menus).
   * Defaults to the chat store's `addContextSelection`, which stages a context
   * chip in the composer's draft — the same channel the diff pane uses.
   */
  onSendToChat?: (selection: FileSelectionRef) => void
}

/** Sidebar collapse threshold — the rail alone is 40px wide. */
const RAIL_WIDTH_PX = 40

/**
 * Narrowest workbench that seats the explorer, a usable editor and the file
 * context workbench side by side (explorer ~25% + editor ~300px + the context
 * workbench's 360px default). The workbench lives in the chat's right dock —
 * 480px at its floor, roughly 540–900px in practice — so below this only one
 * of the two side panels stays open: opening one folds the other.
 */
const SIDE_PANELS_MIN_WIDTH_PX = 880

/** The file context workbench's "wide" preset, as a share of the workbench. */
const CONTEXT_PANEL_WIDE_PERCENT = 60

/** Largest share the file context workbench may take from the editor. */
const CONTEXT_PANEL_MAX_PERCENT = 65

/** Workbench chords Monaco would otherwise swallow — see `editorContextActions`. */
const WORKBENCH_MONACO_BINDINGS: Record<string, string> = {
  "workbench.goToSymbol": "Ctrl+Shift+O",
  "workbench.previewToSide": "Ctrl+K V",
  "workbench.zenMode": "Ctrl+K Z",
}

/**
 * The editor workbench, VS Code's arrangement: the primary sidebar (activity
 * rail + Explorer/Search) on the left, editor groups — each with its own tab
 * strip — in the middle, and the file context workbench (AI, comments,
 * inspect, outline, proposal review) as the secondary sidebar on the right.
 */
export function ProjectEditorFileWorkbench({
  workbench,
  panelIdPrefix,
  active = true,
  gitDeps,
  searchDeps,
  quickOpenDeps,
  onSendToChat,
}: ProjectEditorFileWorkbenchProps) {
  const t = useTranslations("projectEditor")
  const [mobileWorkbenchOpen, setMobileWorkbenchOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [cursor, setCursor] = useState<{
    relPath: string
    lineNumber: number
    column: number
  } | null>(null)
  const [editorSelectionState, setEditorSelectionState] = useState<{
    relPath: string
    selection: TextSelectionCoordinates | undefined
  } | null>(null)
  // Diagnostics are keyed by relPath (not a single "current" slot) because two
  // panes each report for their own file — a shared slot would fight.
  const [diagnosticsByPath, setDiagnosticsByPath] = useState<
    ReadonlyMap<string, { monaco: MonacoLike; editor: EditorLike }>
  >(new Map())
  const {
    layout,
    actions,
    actionLabels,
    bindings,
    confirmRequest,
    editor,
    focusedGroup,
    gotoLine,
    groupActive,
    minimapEnabled,
    mobilePane,
    moveToGroup,
    moveToOtherGroup,
    openFromTree,
    openPathsByRecency,
    primaryFiles,
    quickOpen,
    quickOpenSeed,
    revealInTree,
    revealRequest,
    resolveConfirm,
    revertFile,
    saveActive,
    saveAll,
    secondaryFiles,
    selectInGroup,
    setMinimapEnabled,
    setMobilePane,
    setMonacoReadHandles,
    setQuickOpen,
    openQuickOpen,
    sideTab,
    setSideTab,
    sidebarPanelRef,
    splitEditor,
    splitVisible,
    focusGroup,
    previewTabs,
    togglePreview,
    previewToSide,
    canPreview,
    isWordWrapped,
    toggleWordWrap,
    editorFontSize,
    zoomEditorFont,
    zenMode,
    setZenMode,
    problemsVisible,
    setProblemsVisible,
    toggleSidebar,
    focusOrCreateGroup,
  } = workbench
  const {
    activeFile,
    activePath,
    closeAllFiles,
    closeFile,
    closeFiles,
    deps,
    dirtyCount,
    moveOpenFile,
    openFiles,
    pinFile,
    previewPath,
    reconcileDeleted,
    reopenClosedFile,
    rootPath,
    saveFile,
    setDraft,
    treeRefreshToken,
  } = editor

  const { branch, byPath: gitDecorations } = useProjectGitStatus(
    rootPath,
    treeRefreshToken,
    gitDeps
  )

  // Whether the file context workbench shows its panel body or only its rail.
  // Persisted per editor scope beside the engine and split layout, and closed
  // until the user opens it — a narrow dock should not hand a third of its
  // width to a panel nobody asked for.
  const contextWorkbenchOpen = useProjectEditorSessionStore(
    (state) => state.sessions[editor.scopeKey]?.contextWorkbenchOpen === true
  )
  const setEditorSession = useProjectEditorSessionStore((state) => state.setSession)
  const setContextWorkbenchOpen = useCallback(
    (open: boolean) => setEditorSession(editor.scopeKey, { contextWorkbenchOpen: open }),
    [editor.scopeKey, setEditorSession]
  )

  // Project-wide script checking: the TS worker's file table mirrors the
  // workspace (open models still shadow their lib — drafts stay live).
  // Split layout only: the phone pane flow edits in CodeMirror, and walking
  // up to a thousand files into Monaco models nothing renders would be pure
  // cost — over a remote host, a thousand reads per root mount.
  useMonacoTsProject(
    rootPath,
    { readFile: deps.readFile, watch: deps.watch, walk: quickOpenDeps?.walk },
    { enabled: layout !== "mobile" }
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
  // Zen mode is a split-layout concept — the mobile pane flow has no
  // rail/sidebar/statusbar chrome to hide in the first place.
  const zen = zenMode && layout !== "mobile"
  // `@` quick-open mode reads the live draft — never disk.
  const quickOpenActiveDoc = useMemo(() => {
    if (!shownFile || shownFile.blocked) return null
    return {
      relPath: shownFile.relPath,
      language: shownFile.monacoLanguage,
      content: shownFile.draftContent,
    }
  }, [shownFile])

  // The phone editor is CodeMirror: goto-line reaches it through this
  // extension (Monaco has its own listener). Keyed on the file so a request
  // for another tab can never land here.
  const shownRelPath = shownFile?.relPath ?? null
  const lightEditorExtensions = useMemo(
    () => (shownRelPath ? [projectEditorGotoExtension(shownRelPath)] : []),
    [shownRelPath]
  )

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
  const diagnostics = shownFile ? (diagnosticsByPath.get(shownFile.relPath) ?? null) : null
  const shownCursor =
    shownFile && cursor?.relPath === shownFile.relPath
      ? { lineNumber: cursor.lineNumber, column: cursor.column }
      : null

  /**
   * Each pane reports its own Monaco handles; the ref keeps them per group so
   * `readActive` can always reach the *focused* group's live editor. The map
   * entry feeds the status bar + context workbench for any visible file.
   */
  const handlesByGroupRef = useRef<[MonacoReadHandles | null, MonacoReadHandles | null]>([
    null,
    null,
  ])
  // ---- status-bar model state ---------------------------------------------
  // Indentation is synced from the live model; the language registry is
  // captured off the first mounted Monaco; overrides survive model swaps.
  const [indentOptions, setIndentOptions] = useState<{
    tabSize: number
    insertSpaces: boolean
  } | null>(null)
  const [languageList, setLanguageList] = useState<{ id: string; label: string }[]>([])
  // The Monaco namespace itself, for the Problems view. Markers live in the
  // instance-global store (open files, the project-wide TS mirrors, anything a
  // plugin pushed), so the panel must not depend on a file being shown.
  const [monacoNamespace, setMonacoNamespace] = useState<MonacoLike | null>(null)
  const [languageOverrides, setLanguageOverrides] = useState<Record<string, string>>({})
  const handleDiagnosticsReady = useCallback(
    (relPath: string, next: { monaco: MonacoLike; editor: EditorLike } | null, group: 0 | 1) => {
      handlesByGroupRef.current[group] = next
        ? {
            monaco: next.monaco,
            editor: next.editor as unknown as ReadableMonacoEditor,
          }
        : null
      if (group === focusedGroup) setMonacoReadHandles(handlesByGroupRef.current[group])
      setDiagnosticsByPath((prev) => {
        if (next === null && !prev.has(relPath)) return prev
        const map = new Map(prev)
        if (next) map.set(relPath, next)
        else map.delete(relPath)
        return map
      })
      // First mounted Monaco carries the language registry — captured here
      // (a commit-time callback) because reading a ref during render is off
      // limits, and the status bar's language picker needs the list.
      if (next) {
        setMonacoNamespace((prev) => prev ?? next.monaco)
        const languages = (
          next.monaco as {
            languages?: { getLanguages?: () => { id: string; aliases?: string[] }[] }
          }
        ).languages?.getLanguages?.()
        if (languages?.length) {
          setLanguageList((prev) =>
            prev.length > 0
              ? prev
              : languages
                  .map((l) => ({ id: l.id, label: l.aliases?.[0] ?? l.id }))
                  .sort((a, b) => a.label.localeCompare(b.label))
          )
        }
      }
    },
    [focusedGroup, setMonacoReadHandles]
  )

  // Opening Problems before any editor mounted (nothing open yet, or only a
  // blocked file) still reaches the marker store: load the namespace itself.
  useEffect(() => {
    if (!problemsVisible || monacoNamespace || layout === "mobile") return
    let cancelled = false
    void loadConfiguredMonaco().then((monaco) => {
      if (!cancelled && monaco) setMonacoNamespace(monaco as unknown as MonacoLike)
    })
    return () => {
      cancelled = true
    }
  }, [layout, monacoNamespace, problemsVisible])

  // A focus flip republishes the other pane's handles without waiting for
  // that pane's next diagnostics event.
  useEffect(() => {
    setMonacoReadHandles(handlesByGroupRef.current[focusedGroup])
  }, [focusedGroup, setMonacoReadHandles])

  // ---- status-bar model actions -------------------------------------------
  // Indentation, line endings and language mode are model-level facts — the
  // status bar writes them through the *focused* pane's live model.
  const focusedModelSlice = useCallback(() => {
    const handles = handlesByGroupRef.current[focusedGroup]
    const editor = handles?.editor as
      | {
          getModel?: () => MutableMonacoModel | null
          getAction?: (id: string) => { run(): void } | null
        }
      | null
      | undefined
    return {
      model: editor?.getModel?.() ?? null,
      editor: editor ?? null,
      monaco: handles?.monaco ?? null,
    }
  }, [focusedGroup])

  // Indentation is read from the live model, so re-sync whenever the focused
  // pane, its document, or its mounted handle could have changed.
  useEffect(() => {
    const { model } = focusedModelSlice()
    const opts = model?.getOptions?.()
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors a
       mutable external model; read at commit time, not during render. */
    setIndentOptions(
      typeof opts?.tabSize === "number"
        ? { tabSize: opts.tabSize, insertSpaces: opts.insertSpaces !== false }
        : null
    )
  }, [focusedGroup, activePath, diagnosticsByPath, focusedModelSlice])

  const setIndentation = useCallback(
    (opts: { tabSize: number; insertSpaces: boolean }) => {
      const { model } = focusedModelSlice()
      if (!model?.updateOptions) return
      model.updateOptions(opts)
      setIndentOptions({ tabSize: opts.tabSize, insertSpaces: opts.insertSpaces })
    },
    [focusedModelSlice]
  )

  const convertIndentation = useCallback(
    (to: "spaces" | "tabs") => {
      const { editor } = focusedModelSlice()
      editor
        ?.getAction?.(
          to === "spaces" ? "editor.action.indentationToSpaces" : "editor.action.indentationToTabs"
        )
        ?.run()
    },
    [focusedModelSlice]
  )

  /** Monaco's EndOfLineSequence — LF is 0, CRLF is 1. */
  const toggleEol = useCallback(() => {
    const { model } = focusedModelSlice()
    if (!model?.setEOL) return
    model.setEOL(model.getEOL?.() === "\r\n" ? 0 : 1)
  }, [focusedModelSlice])

  const setLanguageMode = useCallback(
    (relPath: string, languageId: string) => {
      const { model, monaco } = focusedModelSlice()
      const ns = monaco as {
        editor?: { setModelLanguage?: (model: unknown, language: string) => void }
      } | null
      ns?.editor?.setModelLanguage?.(model, languageId)
      setLanguageOverrides((prev) => ({ ...prev, [relPath]: languageId }))
    },
    [focusedModelSlice]
  )

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

  /**
   * Saving a `deletedOnDisk` buffer writes it back — that IS the restore
   * path. `force` skips the external-change confirm; a deleted file has no
   * disk side to conflict with.
   */
  const restoreDeletedFile = useCallback(
    (relPath: string) => {
      void saveFile(relPath, { force: true }).catch((error) =>
        toast.error(t("saveFailed", { error: String(error) }))
      )
    },
    [saveFile, t]
  )

  /** Disk-vs-draft comparison for a conflicted tab — read the disk side lazily. */
  const [compareTarget, setCompareTarget] = useState<{
    relPath: string
    diskContent: string
  } | null>(null)
  const openCompare = useCallback(
    async (relPath: string) => {
      try {
        const diskContent = await deps.readFile(rootPath, relPath)
        setCompareTarget({ relPath, diskContent })
      } catch (error) {
        toast.error(t("sync.compareFailed", { error: String(error) }))
      }
    },
    [deps, rootPath, t]
  )

  /** Status-bar chip: deleted → restore the buffer, conflicted → open compare. */
  const syncChipAction = useCallback(() => {
    if (!shownFile) return
    if (shownFile.deletedOnDisk) restoreDeletedFile(shownFile.relPath)
    else if (shownFile.externallyChanged) void openCompare(shownFile.relPath)
  }, [shownFile, restoreDeletedFile, openCompare])

  /** A tree delete also reconciles any open tabs under the deleted path. */
  const onTreeDeleted = useCallback(
    (relPath: string) => reconcileDeleted([relPath]),
    [reconcileDeleted]
  )

  const openAnyway = useCallback(
    (relPath: string) => {
      void editor.openFile(relPath, { allowLarge: true })
    },
    [editor]
  )

  const openSearchPane = useCallback(() => {
    setSideTab("search")
    setMobilePane("search")
    sidebarPanelRef.current?.expand()
  }, [setMobilePane, setSideTab, sidebarPanelRef])

  // ---- context-menu / agent linkage -----------------------------------------
  //
  // `sendToChat` stages a context chip in the chat composer — the same
  // `addContextSelection` channel the diff pane uses, so the agent turn sees
  // exactly what the user pointed at. The prop override is the test seam.
  const addContextSelection = useChatStore((state) => state.addContextSelection)
  const sendToChat = useMemo(
    () => onSendToChat ?? ((selection: FileSelectionRef) => addContextSelection(selection)),
    [onSendToChat, addContextSelection]
  )
  const fileChatDeps = useMemo(() => ({ readFile: deps.readFile, listDir: deps.listDir }), [deps])
  const chatDraftOf = useCallback(
    (relPath: string) => openFiles.find((f) => f.relPath === relPath)?.draftContent,
    [openFiles]
  )
  const confirmStaged = useCallback(
    (name: string) => toast.success(t("agent.addedToChat", { name })),
    [t]
  )

  const stageFileToChat = useCallback(
    (relPath: string) => {
      void buildFileContextSelection({
        rootPath,
        relPath,
        draftContent: chatDraftOf(relPath),
        deps: fileChatDeps,
      }).then((sel) => {
        sendToChat(sel)
        confirmStaged(sel.title)
      })
    },
    [chatDraftOf, confirmStaged, fileChatDeps, rootPath, sendToChat]
  )

  const stageEntryToChat = useCallback(
    (relPath: string, isDir: boolean) => {
      const build = isDir
        ? buildFolderContextSelection({ rootPath, relPath, deps: fileChatDeps })
        : buildFileContextSelection({
            rootPath,
            relPath,
            draftContent: chatDraftOf(relPath),
            deps: fileChatDeps,
          })
      void build.then((sel) => {
        sendToChat(sel)
        confirmStaged(sel.title)
      })
    },
    [chatDraftOf, confirmStaged, fileChatDeps, rootPath, sendToChat]
  )

  const stageMarkerToChat = useCallback(
    (relPath: string, marker: WorkbenchMarker) => {
      void buildProblemContextSelection({
        rootPath,
        relPath,
        marker,
        draftContent: chatDraftOf(relPath),
        deps: fileChatDeps,
      }).then((sel) => {
        sendToChat(sel)
        confirmStaged(sel.title)
      })
    },
    [chatDraftOf, confirmStaged, fileChatDeps, rootPath, sendToChat]
  )

  const stageMarkersToChat = useCallback(
    (relPath: string, markers: WorkbenchMarker[]) => {
      const sel = buildProblemsContextSelection({ relPath, markers })
      sendToChat(sel)
      confirmStaged(sel.title)
    },
    [confirmStaged, sendToChat]
  )

  /**
   * The Monaco context-menu action's run: stage the live selection (with its
   * line range) — or the whole file when the caret has no selection. The
   * model URI, not `activePath`, names the file: with two groups mounted the
   * action fires in whichever editor was right-clicked.
   */
  const stageEditorSelectionToChat = useCallback(
    (ed: unknown) => {
      const editor = ed as {
        getModel?: () => {
          uri?: { toString(): string }
          getValue?: () => string
          getValueInRange?: (range: unknown) => string
        } | null
        getSelection?: () => {
          isEmpty(): boolean
          startLineNumber: number
          endLineNumber: number
        } | null
      }
      const model = editor.getModel?.()
      const abs = model?.uri ? fileUriToPath(model.uri.toString()) : null
      const rootPrefix = `${rootPath.replace(/\/+$/, "")}/`
      const relPath =
        abs && abs.startsWith(rootPrefix)
          ? abs.slice(rootPrefix.length)
          : abs === rootPath.replace(/\/+$/, "")
            ? ""
            : null
      if (!relPath) return
      const sel = editor.getSelection?.()
      const range = sel && !sel.isEmpty() ? sel : null
      void buildFileContextSelection({
        rootPath,
        relPath,
        // The live model IS the draft — this also covers files whose openFiles
        // entry hasn't been looked up yet.
        draftContent: model?.getValue?.() ?? chatDraftOf(relPath),
        range: range
          ? { startLine: range.startLineNumber, endLine: range.endLineNumber }
          : undefined,
        selectedText: range ? model?.getValueInRange?.(range) : undefined,
        deps: fileChatDeps,
      }).then((sel) => {
        sendToChat(sel)
        confirmStaged(sel.title)
      })
    },
    [chatDraftOf, confirmStaged, fileChatDeps, rootPath, sendToChat]
  )

  /**
   * VS Code's "Open to the Side" — the file lands in (or moves to) group 2.
   * Marking group membership FIRST means `openFromTree`'s own group routing
   * converges on group 1 for every case: a fresh open, a re-activation, and a
   * file that was already open in group 0 (this editor's one-doc-per-group
   * model relocates it rather than duplicating the editor, which VS Code's
   * split does allow — moving is the closest honest equivalent).
   */
  const openToSide = useCallback(
    (relPath: string) => {
      moveToGroup(relPath, 1)
      openFromTree(relPath, { mode: "pinned" })
    },
    [moveToGroup, openFromTree]
  )

  /** VS Code's "Find in Folder" — the search panel scopes to the directory. */
  const [searchScope, setSearchScope] = useState<string | null>(null)
  const findInFolder = useCallback(
    (relPath: string) => {
      setSearchScope(relPath)
      openSearchPane()
    },
    [openSearchPane]
  )

  // The OS file manager exists only under the desktop shell — the tree hides
  // the row's "Reveal in File Explorer" item when no handler is passed.
  const revealInSystem = useMemo(
    () =>
      isTauri()
        ? (relPath: string) => {
            void revealInExplorer(joinPath(rootPath, relPath)).catch((error) =>
              toast.error(t("revealSystemFailed", { error: String(error) }))
            )
          }
        : undefined,
    [rootPath, t]
  )

  /** Format via the focused pane's live Monaco editor, if one is mounted. */
  const formatActive = useCallback(() => {
    const editorHandle = handlesByGroupRef.current[focusedGroup]?.editor as
      { trigger?: (source: string, command: string, payload: unknown) => void } | null | undefined
    editorHandle?.trigger?.("palette", "editor.action.formatDocument", null)
  }, [focusedGroup])

  /**
   * The tabs a strip's close actions act on: one editor group's, or — for the
   * phone layout's single strip — every open file, whichever group a
   * desktop-width session left it in.
   */
  const stripMembers = useCallback(
    (scope: 0 | 1 | "all") =>
      scope === "all" ? openFiles : scope === 1 ? secondaryFiles : primaryFiles,
    [openFiles, primaryFiles, secondaryFiles]
  )

  /** Close every other tab in the strip this file belongs to. */
  const closeOthersInGroup = useCallback(
    (relPath: string, scope: 0 | 1 | "all") => {
      const members = stripMembers(scope)
      closeFiles(new Set(members.map((f) => f.relPath).filter((p) => p !== relPath)))
    },
    [closeFiles, stripMembers]
  )

  const closeToRightInGroup = useCallback(
    (relPath: string, scope: 0 | 1 | "all") => {
      const members = stripMembers(scope)
      const idx = members.findIndex((f) => f.relPath === relPath)
      if (idx === -1) return
      closeFiles(new Set(members.slice(idx + 1).map((f) => f.relPath)))
    },
    [closeFiles, stripMembers]
  )

  /**
   * A tab menu's "Close All" closes its own strip, as VS Code's does; the
   * palette's "Close All Editors" is the workbench-wide one.
   */
  const closeAllInGroup = useCallback(
    (scope: 0 | 1 | "all") => {
      if (scope === "all") closeAllFiles()
      else closeFiles(new Set(stripMembers(scope).map((f) => f.relPath)))
    },
    [closeAllFiles, closeFiles, stripMembers]
  )

  /**
   * The text-area right-click menu — VS Code's group layout:
   * navigation → modification → clipboard → command palette. The built-in ids
   * were verified against monaco-editor@0.56 (`editor.action.goToReferences`,
   * `editor.action.rename`, `editor.action.changeAll`, `editor.action.quickCommand`
   * for the Command Palette). The custom "Add to Chat" action's `run` receives
   * the editor instance the user clicked — with two groups mounted that is not
   * necessarily the active one, so the model URI names the file.
   */
  const editorActionLabels = useMemo(
    () => ({
      "workbench.goToReferences": t("action.goToReferences"),
      "workbench.goToImplementation": t("action.goToImplementation"),
      "workbench.renameSymbol": t("action.renameSymbol"),
      "workbench.changeAll": t("action.changeAllOccurrences"),
      "workbench.addSelectionToChat": t("action.addSelectionToChat"),
      "workbench.addFileToChat": t("action.addFileToChat"),
      "workbench.commandPalette": t("command.palette"),
      "workbench.goToSymbol": t("command.goToSymbol"),
      "workbench.previewToSide": t("command.previewToSide"),
      "workbench.zenMode": t("command.zenMode"),
    }),
    [t]
  )
  const editorContextActions = useMemo<EditorActionDef[]>(
    () => [
      {
        id: "workbench.goToReferences",
        label: editorActionLabels["workbench.goToReferences"],
        monacoCommand: "editor.action.goToReferences",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 3,
        alwaysAvailable: true,
      },
      {
        id: "workbench.goToImplementation",
        label: editorActionLabels["workbench.goToImplementation"],
        monacoCommand: "editor.action.goToImplementation",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 4,
        alwaysAvailable: true,
      },
      {
        id: "workbench.renameSymbol",
        label: editorActionLabels["workbench.renameSymbol"],
        monacoCommand: "editor.action.rename",
        contextMenuGroupId: "1_modification",
        contextMenuOrder: 1,
        alwaysAvailable: true,
      },
      {
        id: "workbench.changeAll",
        label: editorActionLabels["workbench.changeAll"],
        monacoCommand: "editor.action.changeAll",
        contextMenuGroupId: "1_modification",
        contextMenuOrder: 2,
        alwaysAvailable: true,
      },
      {
        id: "workbench.addSelectionToChat",
        label: editorActionLabels["workbench.addSelectionToChat"],
        run: (ed) => stageEditorSelectionToChat(ed),
        contextMenuGroupId: "9_cutcopypaste",
        contextMenuOrder: 4,
        alwaysAvailable: true,
      },
      {
        id: "workbench.addFileToChat",
        label: editorActionLabels["workbench.addFileToChat"],
        run: () => {
          if (activePath) stageFileToChat(activePath)
        },
        contextMenuGroupId: "9_cutcopypaste",
        contextMenuOrder: 5,
        alwaysAvailable: true,
      },
      {
        // The workbench palette, not Monaco's own F1 list: this item carries
        // the workbench palette's label and ⇧⌘P opens the workbench palette,
        // so the menu must too. Monaco's editor commands stay on F1.
        id: "workbench.commandPalette",
        label: editorActionLabels["workbench.commandPalette"],
        run: () => openQuickOpen(">"),
        contextMenuGroupId: "z_commands",
        contextMenuOrder: 1,
        alwaysAvailable: true,
      },
      // Keybinding-only actions (no context-menu group): Monaco owns ⌘K as a
      // chord prefix and ⇧⌘O as its quick outline, and stops the keydown
      // before it can bubble to the workbench handler — so inside the editor
      // these chords only reach the workbench as Monaco keybindings.
      {
        id: "workbench.goToSymbol",
        label: editorActionLabels["workbench.goToSymbol"],
        run: () => openQuickOpen("@"),
      },
      {
        id: "workbench.previewToSide",
        label: editorActionLabels["workbench.previewToSide"],
        run: previewToSide,
      },
      {
        id: "workbench.zenMode",
        label: editorActionLabels["workbench.zenMode"],
        run: () => setZenMode((v) => !v),
      },
    ],
    [
      activePath,
      editorActionLabels,
      openQuickOpen,
      previewToSide,
      setZenMode,
      stageEditorSelectionToChat,
      stageFileToChat,
    ]
  )
  const mergedEditorActions = useMemo(
    () => [...actions, ...editorContextActions],
    [actions, editorContextActions]
  )
  const mergedEditorActionLabels = useMemo(
    () => ({ ...actionLabels, ...editorActionLabels }),
    [actionLabels, editorActionLabels]
  )
  // The editor-scope bindings Monaco registers for the workbench actions
  // above, on top of the user's editor keybindings. `Ctrl` folds to ⌘ on
  // macOS (see `keyComboToMonaco`); the space separates a chord's strokes.
  const editorBindings = useMemo(() => ({ ...bindings, ...WORKBENCH_MONACO_BINDINGS }), [bindings])

  /** Monaco's "Go to Next Problem (in Files)" on the focused pane's editor. */
  const nextProblem = useCallback(() => {
    const editorHandle = handlesByGroupRef.current[focusedGroup]?.editor as
      { trigger?: (source: string, command: string, payload: unknown) => void } | null | undefined
    if (editorHandle?.trigger) {
      editorHandle.trigger("palette", "editor.action.marker.nextInFiles", null)
      return
    }
    // No mounted editor to step through — the Problems panel lists them all.
    setProblemsVisible(true)
  }, [focusedGroup, setProblemsVisible])

  // The palette lists what this layout can actually do: the phone pane flow
  // has no sidebar, second group, minimap, Problems panel or zen, and runs on
  // CodeMirror, so Monaco-only commands (format, next problem) are absent too.
  const workbenchCommands = useMemo<QuickOpenCommand[]>(() => {
    const desktop = layout !== "mobile"
    const previewable = shownFile !== null && canPreview(shownFile.relPath)
    // Built with conditional spreads rather than a post-hoc filter: calling a
    // method on an array of ref-reading callbacks during render trips the
    // React compiler's ref analysis.
    return [
      { id: "file.save", label: t("command.save"), hint: "⌘S", run: saveActive },
      { id: "file.saveAll", label: t("command.saveAll"), hint: "⇧⌘S", run: saveAll },
      {
        id: "workbench.goToFile",
        label: t("command.goToFile"),
        hint: "⌘P",
        run: () => openQuickOpen(""),
      },
      {
        id: "workbench.commandPalette",
        label: t("command.palette"),
        hint: "⇧⌘P",
        run: () => openQuickOpen(">"),
      },
      ...(desktop
        ? [
            {
              id: "workbench.toggleSidebar",
              label: t("command.toggleSidebar"),
              hint: "⌘B",
              run: toggleSidebar,
            },
            {
              id: "workbench.zenMode",
              label: t("command.zenMode"),
              hint: "⌘K Z",
              run: () => setZenMode((v) => !v),
            },
            {
              id: "workbench.toggleProblems",
              label: t("command.toggleProblems"),
              hint: "⇧⌘M",
              run: () => setProblemsVisible((v) => !v),
            },
            {
              id: "editor.nextProblem",
              label: t("command.nextProblem"),
              hint: "F8",
              run: nextProblem,
            },
          ]
        : []),
      {
        id: "editor.goToSymbol",
        label: t("command.goToSymbol"),
        hint: "⇧⌘O",
        run: () => openQuickOpen("@"),
      },
      ...(desktop
        ? [
            {
              id: "workbench.toggleMinimap",
              label: t("command.toggleMinimap"),
              run: () => setMinimapEnabled((v) => !v),
            },
            {
              id: "editor.splitRight",
              label: t("command.splitEditor"),
              hint: "⌘\\",
              run: splitEditor,
            },
            ...(splitVisible
              ? [
                  {
                    id: "workbench.focusFirstGroup",
                    label: t("command.focusFirstGroup"),
                    hint: "⌘1",
                    run: () => focusOrCreateGroup(0),
                  },
                ]
              : []),
            {
              id: "workbench.focusSecondGroup",
              label: t("command.focusSecondGroup"),
              hint: "⌘2",
              run: () => focusOrCreateGroup(1),
            },
          ]
        : []),
      {
        id: "editor.revert",
        label: t("command.revert"),
        run: () => {
          if (shownFile) revertFile(shownFile.relPath)
        },
      },
      {
        id: "editor.closeActive",
        label: t("command.closeActive"),
        hint: "⌘W",
        run: () => {
          if (activePath) closeFile(activePath)
        },
      },
      {
        id: "editor.closeOthers",
        label: t("command.closeOthers"),
        run: () => {
          if (activePath) closeOthersInGroup(activePath, desktop ? focusedGroup : "all")
        },
      },
      { id: "editor.closeAll", label: t("command.closeAll"), run: closeAllFiles },
      {
        id: "editor.reopenClosed",
        label: t("command.reopen"),
        hint: "⇧⌘T",
        run: reopenClosedFile,
      },
      {
        id: "explorer.revealActive",
        label: t("command.revealActive"),
        run: () => {
          if (shownFile) revealInTree(shownFile.relPath)
        },
      },
      {
        id: "search.project",
        label: t("command.searchProject"),
        hint: "⇧⌘F",
        run: openSearchPane,
      },
      ...(desktop ? [{ id: "editor.format", label: t("command.format"), run: formatActive }] : []),
      // Preview commands exist only for files the viewer registry can render
      // — a .ts tab must not offer a preview that would be a no-op anyway.
      ...(previewable
        ? [
            {
              id: "editor.togglePreview",
              label: t("command.togglePreview"),
              hint: "⇧⌘V",
              run: () => togglePreview(),
            },
          ]
        : []),
      ...(desktop && previewable
        ? [
            {
              id: "editor.previewToSide",
              label: t("command.previewToSide"),
              hint: "⌘K V",
              run: previewToSide,
            },
          ]
        : []),
      // The status bar's model controls, for when the dock is too narrow to
      // show them there: its indentation and line-ending items are the first
      // to fold away, and the palette is where VS Code keeps them anyway.
      ...(desktop && indentOptions
        ? [
            {
              id: "editor.indentUsingSpaces",
              label: t("statusBar.indentUsingSpaces"),
              run: () => setIndentation({ insertSpaces: true, tabSize: indentOptions.tabSize }),
            },
            {
              id: "editor.indentUsingTabs",
              label: t("statusBar.indentUsingTabs"),
              run: () => setIndentation({ insertSpaces: false, tabSize: indentOptions.tabSize }),
            },
            {
              id: "editor.convertIndentationToSpaces",
              label: t("statusBar.convertToSpaces"),
              run: () => convertIndentation("spaces"),
            },
            {
              id: "editor.convertIndentationToTabs",
              label: t("statusBar.convertToTabs"),
              run: () => convertIndentation("tabs"),
            },
          ]
        : []),
      ...(desktop && diagnostics && shownFile
        ? [
            {
              id: "editor.changeEol",
              label: t("command.changeEol", {
                eol: shownFile.draftContent.includes("\r\n") ? "LF" : "CRLF",
              }),
              run: toggleEol,
            },
          ]
        : []),
      {
        id: "editor.toggleWordWrap",
        label: t("command.toggleWordWrap"),
        hint: "⌥Z",
        run: toggleWordWrap,
      },
      {
        id: "editor.fontZoomIn",
        label: t("command.fontZoomIn"),
        hint: "⌘=",
        run: () => zoomEditorFont(1),
      },
      {
        id: "editor.fontZoomOut",
        label: t("command.fontZoomOut"),
        hint: "⌘-",
        run: () => zoomEditorFont(-1),
      },
      {
        id: "editor.fontZoomReset",
        label: t("command.fontZoomReset"),
        hint: "⌘0",
        run: () => zoomEditorFont("reset"),
      },
    ]
  }, [
    activePath,
    canPreview,
    closeAllFiles,
    closeFile,
    closeOthersInGroup,
    convertIndentation,
    diagnostics,
    focusOrCreateGroup,
    focusedGroup,
    formatActive,
    indentOptions,
    layout,
    nextProblem,
    openQuickOpen,
    openSearchPane,
    previewToSide,
    reopenClosedFile,
    revealInTree,
    revertFile,
    saveActive,
    saveAll,
    setIndentation,
    setMinimapEnabled,
    setProblemsVisible,
    setZenMode,
    shownFile,
    splitEditor,
    splitVisible,
    t,
    toggleEol,
    toggleSidebar,
    togglePreview,
    toggleWordWrap,
    zoomEditorFont,
  ])

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
        onDeleted={onTreeDeleted}
        deps={deps}
        density={layout === "mobile" ? "touch" : "compact"}
        gitDecorations={gitDecorations}
        onCopyPath={copyPath}
        // "Open to the Side" needs a second editor group — desktop only.
        onOpenToSide={layout === "mobile" ? undefined : openToSide}
        onRevealInSystem={revealInSystem}
        onAddToChat={stageEntryToChat}
        onFindInFolder={findInFolder}
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
      openToSide,
      revealInSystem,
      stageEntryToChat,
      findInFolder,
      editor.renameOpenFile,
      onTreeDeleted,
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
        deps={searchDeps}
        scopeRelPath={searchScope}
        onClearScope={() => setSearchScope(null)}
        onCopyPath={copyPath}
        onRevealInExplorer={revealInTree}
      />
    ),
    [rootPath, searchVisible, gotoLine, layout, searchDeps, searchScope, copyPath, revealInTree]
  )

  // Editor-title actions sit on the breadcrumb row (VS Code's title area).
  // The eye toggles the per-tab rich preview; it only exists for file types
  // the viewer registry can render — a plain .ts editor never shows it.
  const breadcrumbsFor = (file: OpenFile | null) =>
    file ? (
      <div className="flex items-center border-b border-border/60 pl-3 pr-1">
        <div className="min-w-0 flex-1">
          <ProjectEditorBreadcrumbs
            rootPath={rootPath}
            rootName={rootName}
            relPath={file.relPath}
            onOpenFile={openFromTree}
            onRevealDir={revealInTree}
            deps={{ listDir: deps.listDir }}
          />
        </div>
        {canPreview(file.relPath) ? (
          <button
            type="button"
            data-testid="editor-preview-toggle"
            data-preview-on={previewTabs.includes(file.relPath) || undefined}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            title={
              previewTabs.includes(file.relPath) ? t("previewCloseHint") : t("previewOpenHint")
            }
            aria-label={
              previewTabs.includes(file.relPath) ? t("previewCloseHint") : t("previewOpenHint")
            }
            onClick={() => togglePreview(file.relPath)}
          >
            {previewTabs.includes(file.relPath) ? (
              <EyeOffIcon className="size-3.5" />
            ) : (
              <EyeIcon className="size-3.5" />
            )}
          </button>
        ) : null}
      </div>
    ) : null
  const breadcrumbs = breadcrumbsFor(shownFile)

  const statusBar = shownFile ? (
    <ProjectEditorStatusBar
      file={shownFile}
      cursor={shownCursor}
      selection={editorSelection}
      diagnostics={diagnostics}
      branch={branch}
      onSyncAction={syncChipAction}
      indent={
        indentOptions
          ? {
              ...indentOptions,
              onChange: setIndentation,
              onConvert: convertIndentation,
            }
          : null
      }
      onToggleEol={diagnostics ? toggleEol : null}
      // VS Code: clicking the status-bar counts opens the Problems panel.
      onProblemsClick={() => setProblemsVisible(true)}
      language={
        languageList.length > 0
          ? {
              value: languageOverrides[shownFile.relPath] ?? shownFile.monacoLanguage,
              options: languageList,
              onChange: (id) => setLanguageMode(shownFile.relPath, id),
            }
          : null
      }
      density={layout === "mobile" ? "touch" : "compact"}
    />
  ) : null

  /**
   * The disk-truth banner for one group's file — shown when the file on disk
   * and the open buffer have diverged. Conflict (dirty + external write):
   * compare, reload, or overwrite. Deleted-on-disk: the buffer is the last
   * copy — restore it or let the tab go.
   */
  const bannerFor = (file: OpenFile | null) =>
    file?.deletedOnDisk === true ? (
      <div
        className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs"
        data-testid="editor-deleted-banner"
        role="status"
      >
        <Trash2Icon className="size-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 truncate text-destructive">{t("sync.deletedBanner")}</span>
        <Button
          size="sm"
          variant="outline"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={() => restoreDeletedFile(file.relPath)}
          data-testid="editor-deleted-restore"
        >
          {t("sync.restoreBuffer")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={() => closeFile(file.relPath)}
          data-testid="editor-deleted-close"
        >
          {t("sync.closeTab")}
        </Button>
      </div>
    ) : file?.externallyChanged === true ? (
      <div
        className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs"
        data-testid="editor-conflict-banner"
        role="status"
      >
        <AlertTriangleIcon className="size-3.5 shrink-0 text-amber-500" />
        <span className="min-w-0 flex-1 truncate text-amber-600 dark:text-amber-400">
          {file.draftContent !== file.savedContent
            ? t("sync.conflictBanner")
            : t("sync.externalBanner")}
        </span>
        {/* Compare in both states — the status-bar chip opens it for a clean
            stale buffer too, and "what changed on disk" is the question
            either way. */}
        <Button
          size="sm"
          variant="outline"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={() => void openCompare(file.relPath)}
          data-testid="editor-conflict-compare"
        >
          {t("sync.compare")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={() => revertFile(file.relPath)}
          data-testid="editor-conflict-reload"
        >
          {t("sync.reloadDisk")}
        </Button>
        {file.draftContent !== file.savedContent ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={() =>
              void saveFile(file.relPath, { force: true }).catch((error) =>
                toast.error(t("saveFailed", { error: String(error) }))
              )
            }
            data-testid="editor-conflict-save"
          >
            {t("sync.saveMine")}
          </Button>
        ) : null}
      </div>
    ) : null
  const syncBanner = bannerFor(shownFile)

  // The disk side was captured at open; the draft side stays live so the
  // diff follows typing while the dialog is up.
  const compareFile = compareTarget
    ? openFiles.find((f) => f.relPath === compareTarget.relPath)
    : null
  const compareDialog = (
    <Dialog
      open={compareTarget !== null && compareFile != null}
      onOpenChange={(open) => {
        if (!open) setCompareTarget(null)
      }}
    >
      <DialogContent
        className="flex h-[80vh] max-w-5xl flex-col gap-3"
        data-testid="editor-compare-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {t("sync.compareTitle", {
              name: compareTarget?.relPath.split("/").pop() ?? "",
            })}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
          {compareTarget && compareFile ? (
            <DiffViewer
              diff={{
                path: compareTarget.relPath,
                oldContent: compareTarget.diskContent,
                newContent: compareFile.draftContent,
                hunks: [],
                isBinary: false,
                language: compareFile.monacoLanguage,
              }}
              staged={false}
              density={layout === "mobile" ? "touch" : "compact"}
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (compareTarget) revertFile(compareTarget.relPath)
              setCompareTarget(null)
            }}
            data-testid="editor-compare-reload"
          >
            {t("sync.reloadDisk")}
          </Button>
          {/* Only a draft is "my version" — overwriting disk with a clean,
              stale buffer would silently revert the external change. */}
          {compareFile && compareFile.draftContent !== compareFile.savedContent ? (
            <Button
              onClick={() => {
                if (compareTarget) {
                  void saveFile(compareTarget.relPath, { force: true }).catch((error) =>
                    toast.error(t("saveFailed", { error: String(error) }))
                  )
                }
                setCompareTarget(null)
              }}
              data-testid="editor-compare-save"
            >
              {t("sync.saveMine")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  // The destructive-gate host: dirty close, overwrite-on-save, and dirty
  // revert all land here instead of `window.confirm`. Dismissing (Esc,
  // scrim click, the Cancel button) answers "no".
  const confirmDialog = (
    <AlertDialog
      open={confirmRequest !== null}
      onOpenChange={(open) => {
        if (!open) resolveConfirm("cancel")
      }}
    >
      <AlertDialogContent data-testid="editor-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{confirmRequest?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => resolveConfirm("cancel")}>
            {t("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => resolveConfirm("confirm")}
            data-testid="editor-confirm-action"
          >
            {confirmRequest?.confirmLabel}
          </AlertDialogAction>
          {confirmRequest?.saveLabel ? (
            <AlertDialogAction
              onClick={() => resolveConfirm("save")}
              data-testid="editor-confirm-save"
            >
              {confirmRequest.saveLabel}
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  const emptyPane = (
    <div
      className="flex h-full flex-1 flex-col items-center justify-center gap-5 p-6"
      data-testid="editor-empty"
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
          onClick={() => openQuickOpen("")}
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
          icon={<TerminalIcon className="size-3.5" />}
          label={t("command.palette")}
          keys="⇧⌘P"
          onClick={() => openQuickOpen(">")}
          testId="editor-empty-palette"
        />
        <EmptyShortcut
          icon={<RotateCcwIcon className="size-3.5" />}
          label={t("tabs.reopenClosed")}
          keys="⇧⌘T"
          onClick={reopenClosedFile}
          testId="editor-empty-reopen"
        />
        {/* The phone pane flow has no sidebar to toggle. */}
        {layout === "mobile" ? null : (
          <EmptyShortcut
            icon={<PanelLeftIcon className="size-3.5" />}
            label={t("command.toggleSidebar")}
            keys="⌘B"
            onClick={toggleSidebar}
            testId="editor-empty-sidebar"
          />
        )}
      </div>
    </div>
  )

  // The file context workbench (AI, comments, inspect, outline, proposal
  // review) acts on the shown file's text — a blocked binary/oversized file
  // has none, and zen mode hides every surface around the editor.
  const contextFile = shownFile && !shownFile.blocked ? shownFile : null

  // --- The file context workbench as the secondary sidebar ---
  //
  // Its width belongs to this workbench, not to the context workbench itself:
  // left to size itself it measured against the window, so its 360px default
  // and `clamp(640px, 50%, 960px)` wide preset could swallow a 480–900px dock
  // whole — and a landing proposal switches it to wide unprompted. As a panel
  // of the editor's resizable group it is bounded by the dock, keeps its pixel
  // width while the dock is dragged, and folds to its 48px rail.
  const contextPanelRef = usePanelRef()
  const hasContextPanel = contextFile !== null && !zen && layout !== "mobile"
  // The width to unfold back to; read only from effects and callbacks.
  const lastContextWidthRef = useRef(CONTEXT_WORKBENCH_DEFAULT_WIDTH)
  // A width request that arrived while the sidebar was folded, applied on unfold.
  const pendingContextModeRef = useRef<Exclude<ContextPanelMode, "focus"> | null>(null)
  const contextPanelMountedRef = useRef(false)
  // Which preset the sidebar is actually sitting at, for the header's
  // narrow/wide highlight. Unknown until the first measurement.
  const [contextPanelMode, setContextPanelMode] = useState<"narrow" | "wide" | undefined>()

  // Open/closed is a persisted per-scope fact; the panel follows it. Not on
  // the commit that mounts the panel: its handle throws until the group has
  // registered it, one render later. It needs nothing then anyway — a first
  // mount takes its size from the open flag (`ContextSidebarPanel`), and a
  // remount (leaving zen, reopening a file) gets the layout the group
  // remembers for that panel set, width included.
  useEffect(() => {
    const panel = contextPanelRef.current
    if (!hasContextPanel || !panel) {
      contextPanelMountedRef.current = false
      return
    }
    if (!contextPanelMountedRef.current) {
      contextPanelMountedRef.current = true
      return
    }
    if (!contextWorkbenchOpen) {
      if (!panel.isCollapsed()) panel.collapse()
      return
    }
    const pending = pendingContextModeRef.current
    pendingContextModeRef.current = null
    if (pending === "wide") panel.resize(`${CONTEXT_PANEL_WIDE_PERCENT}%`)
    else if (panel.isCollapsed()) panel.resize(`${lastContextWidthRef.current}px`)
  }, [contextPanelRef, contextWorkbenchOpen, hasContextPanel])

  // The context workbench's narrow/wide requests. A panel activation names its
  // panel and may widen the sidebar, never narrow it — the chat dock's
  // high-water contract, so moving between panels never undoes a width the
  // user dragged to. The header's own buttons name none and apply as asked.
  const hintContextWidth = useCallback(
    (mode: ContextPanelMode, panelId?: string) => {
      if (mode === "focus") return
      const panel = contextPanelRef.current
      if (!panel) return
      if (panel.isCollapsed()) {
        pendingContextModeRef.current = mode
        return
      }
      if (panelId) {
        const { asPercentage, inPixels } = panel.getSize()
        const groupPx = asPercentage > 0 ? (inPixels * 100) / asPercentage : 0
        const targetPx =
          mode === "wide"
            ? (groupPx * CONTEXT_PANEL_WIDE_PERCENT) / 100
            : CONTEXT_WORKBENCH_DEFAULT_WIDTH
        if (groupPx === 0 || targetPx <= inPixels) return
      }
      panel.resize(
        mode === "wide" ? `${CONTEXT_PANEL_WIDE_PERCENT}%` : `${CONTEXT_WORKBENCH_DEFAULT_WIDTH}px`
      )
    },
    [contextPanelRef]
  )

  // One side panel at a time in a dock too narrow for both: the one opened
  // last stays, the other folds to its rail. With no transition to go on (both
  // restored open), the context workbench — an explicit, persisted choice —
  // keeps its place over the explorer's default.
  const workbenchRef = useRef<HTMLDivElement | null>(null)
  const workbenchWidth = useElementWidth(workbenchRef)
  const tooNarrowForBothSides = workbenchWidth > 0 && workbenchWidth < SIDE_PANELS_MIN_WIDTH_PX
  const lastOpenedSideRef = useRef<"explorer" | "context">("context")
  const previousSidesRef = useRef({
    explorerOpen: !sidebarCollapsed,
    contextOpen: contextWorkbenchOpen,
  })
  useEffect(() => {
    const explorerOpen = !sidebarCollapsed
    const previous = previousSidesRef.current
    if (explorerOpen && !previous.explorerOpen) lastOpenedSideRef.current = "explorer"
    if (contextWorkbenchOpen && !previous.contextOpen) lastOpenedSideRef.current = "context"
    previousSidesRef.current = { explorerOpen, contextOpen: contextWorkbenchOpen }
    if (!tooNarrowForBothSides || !hasContextPanel || !explorerOpen || !contextWorkbenchOpen) return
    // A frame later: leaving zen remounts both side panels in this very
    // commit, and neither handle answers until the group has registered it.
    const frame = requestAnimationFrame(() => {
      if (lastOpenedSideRef.current === "context") sidebarPanelRef.current?.collapse()
      else setContextWorkbenchOpen(false)
    })
    return () => cancelAnimationFrame(frame)
  }, [
    contextWorkbenchOpen,
    hasContextPanel,
    setContextWorkbenchOpen,
    sidebarCollapsed,
    sidebarPanelRef,
    tooNarrowForBothSides,
  ])

  if (layout === "mobile") {
    // One strip for every open file: the mobile pane flow renders a single
    // editor, so it lists — and closes across — the whole open set, whichever
    // group a desktop-width session left a file in. Selecting a file that
    // lives in the second group is fine: the group reconcile follows it.
    const mobileTabs =
      openFiles.length > 0 ? (
        <ProjectEditorTabs
          density="touch"
          files={openFiles}
          activePath={activePath}
          previewPath={previewPath}
          dirtyCount={dirtyCount}
          onSelect={editor.setActivePath}
          onClose={closeFile}
          onPin={pinFile}
          onSaveAll={saveAll}
          onMove={moveOpenFile}
          onCloseOthers={(relPath) => closeOthersInGroup(relPath, "all")}
          onCloseToRight={(relPath) => closeToRightInGroup(relPath, "all")}
          onCloseAll={() => closeAllInGroup("all")}
          onReopenClosed={reopenClosedFile}
          onCopyPath={copyPath}
          onRevert={revertFile}
          onRevealInExplorer={revealInTree}
          onAddToChat={stageFileToChat}
        />
      ) : null
    const mobileEditorContent = shownFile ? (
      <div className="flex h-full flex-col">
        {mobileTabs}
        {breadcrumbs}
        {syncBanner}
        <div className="relative min-h-0 flex-1">
          {shownFile.blocked ? (
            <ProjectFileFallback
              file={shownFile}
              rootPath={rootPath}
              onOpenAnyway={() => openAnyway(shownFile.relPath)}
              readFileBase64={deps.readFileBase64}
              density="touch"
            />
          ) : (
            <LightCodeEditor
              key={shownFile.absolutePath}
              value={shownFile.draftContent}
              language={shownFile.language}
              onChange={(value) => setDraft(shownFile.relPath, value)}
              wordWrap={isWordWrapped(shownFile.relPath)}
              fontSize={editorFontSize}
              extensions={lightEditorExtensions}
              aria-label={shownFile.relPath}
            />
          )}
          {/* Same per-tab preview as the desktop groups: rendered over the
              editor from the live draft, the editor kept mounted beneath. */}
          {previewTabs.includes(shownFile.relPath) && !shownFile.blocked ? (
            <div
              className="absolute inset-0 z-10 bg-background"
              data-testid="editor-preview-overlay"
            >
              <ProjectFilePreviewPanel
                relPath={shownFile.relPath}
                content={shownFile.draftContent}
              />
            </div>
          ) : null}
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

    // The desktop sidebar's title row, plus the two pickers a phone has no
    // chord for: Go to File and the command palette.
    const mobilePaneHeader = (title: string) => (
      <div className="flex h-11 shrink-0 items-center gap-1 border-b pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </span>
        <button
          type="button"
          className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t("quickOpen.hint")}
          data-testid="project-editor-mobile-quick-open"
          onClick={() => openQuickOpen("")}
        >
          <FolderSearchIcon className="size-4" />
        </button>
        <button
          type="button"
          className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t("command.palette")}
          data-testid="project-editor-mobile-palette"
          onClick={() => openQuickOpen(">")}
        >
          <TerminalIcon className="size-4" />
        </button>
      </div>
    )

    return (
      <>
        <div className="flex h-full min-h-0 flex-col" data-testid="project-editor-mobile-layout">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <div className="flex h-full min-h-0 flex-col" hidden={mobilePane !== "files"}>
              {mobilePaneHeader(t("sidebar.explorer"))}
              <div className="min-h-0 flex-1">{fileTree}</div>
            </div>
            <div className="flex h-full min-h-0 flex-col" hidden={mobilePane !== "search"}>
              {mobilePaneHeader(t("sidebar.search"))}
              <div className="min-h-0 flex-1">{searchPanel}</div>
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
            {contextFile ? (
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
        {contextFile ? (
          <ProjectContextWorkbenchMobile
            scopeKey={editor.scopeKey}
            rootPath={rootPath}
            file={contextFile}
            onDraftChange={(content) => setDraft(contextFile.relPath, content)}
            selection={editorSelection}
            open={mobileWorkbenchOpen}
            onOpenChange={setMobileWorkbenchOpen}
          />
        ) : null}
        <ProjectQuickOpen
          rootPath={rootPath}
          open={quickOpen}
          onOpenChange={setQuickOpen}
          seedQuery={quickOpenSeed}
          commands={workbenchCommands}
          openPaths={openPathsByRecency}
          activeDocument={quickOpenActiveDoc}
          deps={quickOpenDeps}
          onOpenFile={(relPath) => {
            setQuickOpen(false)
            openFromTree(relPath)
          }}
          onGoToLine={(relPath, line, column) => {
            setQuickOpen(false)
            const target = relPath ?? activePath
            if (target) gotoLine(target, line, column)
          }}
        />
        {compareDialog}
        {confirmDialog}
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
        "before:absolute before:top-1 before:bottom-1 before:-left-1 before:w-0.5 before:rounded-full before:bg-primary"
    )

  const selectSideTab = (tab: "files" | "search") => {
    if (sideTab === tab && !sidebarCollapsed) {
      sidebarPanelRef.current?.collapse()
      return
    }
    setSideTab(tab)
    sidebarPanelRef.current?.expand()
  }

  const rail = (
    // The app root mounts a provider already; nesting one here keeps the rail
    // self-sufficient when the workbench renders without it (tests, embeds).
    <TooltipProvider delayDuration={400}>
      <div
        className="flex w-10 shrink-0 flex-col items-center gap-1 border-r bg-muted/30 py-2"
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
          <TooltipContent side="right">{t("filesTab")}</TooltipContent>
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
          <TooltipContent side="right">{t("searchTab")}</TooltipContent>
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
            <TooltipContent side="right">{t("quickOpen.hint")} ⌘P</TooltipContent>
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
                  <PanelLeftOpenIcon className="size-4" />
                ) : (
                  <PanelLeftCloseIcon className="size-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {sidebarCollapsed ? t("sidebar.expand") : t("sidebar.collapse")} ⌘B
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
      // Dragging the dock resizes the editor, not the explorer (VS Code).
      groupResizeBehavior="preserve-pixel-size"
      panelRef={sidebarPanelRef}
      onResize={(size) => setSidebarCollapsed(size.inPixels <= RAIL_WIDTH_PX + 8)}
      className="min-h-0"
    >
      <div className="flex h-full min-h-0">
        {rail}
        <div
          className={cn("flex min-w-0 flex-1 flex-col", sidebarCollapsed && "hidden")}
          data-testid="project-editor-sidebar-content"
        >
          <div className="flex h-9 shrink-0 items-center border-b px-3">
            <span className="truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
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
      </div>
    </ResizablePanel>
  )

  /**
   * One editor group: its own tab strip, breadcrumbs, sync banner, and Monaco
   * instance. The focused pane additionally hosts the loading veil and reports
   * cursor/selection. Clicking anywhere in an unfocused pane claims focus
   * (VS Code parity).
   */
  const renderGroupPane = (group: 0 | 1) => {
    const members = group === 1 ? secondaryFiles : primaryFiles
    const focused = group === focusedGroup
    const groupFile = focused
      ? shownFile
      : (members.find((f) => f.relPath === groupActive[group]) ?? members.at(-1) ?? null)
    // One Save All for the whole editor area: it sits at the far end of the
    // last visible strip, where a split does not repeat it.
    const lastStrip = group === 1 || !splitVisible
    return (
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid={`editor-group-${group}`}
        data-focused={focused || undefined}
        onPointerDownCapture={focused ? undefined : () => focusGroup(group)}
        // A tab dropped anywhere on the other group moves there — VS Code's
        // drag-between-groups. Same-group drops fall through to the tab's own
        // reorder handling (it runs first via bubbling anyway).
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(EDITOR_TAB_DRAG_MIME)) e.preventDefault()
        }}
        onDrop={(e) => {
          const from = e.dataTransfer.getData(EDITOR_TAB_DRAG_MIME)
          if (!from) return
          const fromGroup = secondaryFiles.some((f) => f.relPath === from) ? 1 : 0
          if (fromGroup !== group) moveToGroup(from, group)
        }}
      >
        {zen ? null : (
          <ProjectEditorTabs
            files={members}
            activePath={groupActive[group]}
            previewPath={previewPath}
            dirtyCount={lastStrip ? dirtyCount : 0}
            inactive={!focused}
            onSelect={(relPath) => selectInGroup(group, relPath)}
            onClose={closeFile}
            onPin={pinFile}
            onSaveAll={saveAll}
            onMove={moveOpenFile}
            onCloseOthers={(relPath) => closeOthersInGroup(relPath, group)}
            onCloseToRight={(relPath) => closeToRightInGroup(relPath, group)}
            onCloseAll={() => closeAllInGroup(group)}
            onReopenClosed={reopenClosedFile}
            onCopyPath={copyPath}
            onRevert={revertFile}
            onMoveToOtherGroup={splitVisible ? moveToOtherGroup : undefined}
            onRevealInExplorer={revealInTree}
            onAddToChat={stageFileToChat}
          />
        )}
        {zen ? null : breadcrumbsFor(groupFile)}
        {bannerFor(groupFile)}
        <div className="relative min-h-0 min-w-0 flex-1">
          {groupFile ? (
            <>
              {groupFile.blocked ? (
                <ProjectFileFallback
                  file={groupFile}
                  rootPath={rootPath}
                  onOpenAnyway={() => openAnyway(groupFile.relPath)}
                  readFileBase64={deps.readFileBase64}
                />
              ) : (
                /* No `key` — one editor serves every tab of its group.
                   Remounting per file destroyed the Monaco model and its
                   undo stack; the model is swapped through `path` instead. */
                <ProjectMonaco
                  file={groupFile}
                  projectRoot={rootPath}
                  language={languageOverrides[groupFile.relPath]}
                  onChange={(value) => setDraft(groupFile.relPath, value)}
                  actions={mergedEditorActions}
                  actionLabels={mergedEditorActionLabels}
                  bindings={editorBindings}
                  minimap={minimapEnabled}
                  wordWrap={isWordWrapped(groupFile.relPath)}
                  fontSize={editorFontSize}
                  onSelectionChange={
                    focused
                      ? (selection) => {
                          setEditorSelectionState({
                            relPath: groupFile.relPath,
                            selection,
                          })
                          // Caret/selection moves are the other half of "the
                          // active editor changed" — the ref-based read above
                          // only covers which file is open.
                          notifyActiveEditorChanged()
                        }
                      : undefined
                  }
                  onCursorChange={
                    focused
                      ? (position) =>
                          setCursor(
                            position
                              ? {
                                  relPath: groupFile.relPath,
                                  lineNumber: position.lineNumber,
                                  column: position.column,
                                }
                              : null
                          )
                      : undefined
                  }
                  onDiagnosticsReady={(relPath, next) =>
                    handleDiagnosticsReady(relPath, next, group)
                  }
                />
              )}
              {/* Per-tab rich preview renders over the editor in place of
                  it (VS Code). Monaco stays mounted underneath — cursor,
                  scroll and the undo stack survive the toggle. The panel
                  is fed the live draft, so unsaved edits preview live. */}
              {previewTabs.includes(groupFile.relPath) && !groupFile.blocked ? (
                <div
                  className="absolute inset-0 z-10 bg-background"
                  data-testid="editor-preview-overlay"
                >
                  <ProjectFilePreviewPanel
                    relPath={groupFile.relPath}
                    content={groupFile.draftContent}
                  />
                </div>
              ) : null}
              {focused ? loadingVeil : null}
            </>
          ) : focused ? (
            (loadingPane ?? emptyPane)
          ) : (
            emptyPane
          )}
        </div>
      </div>
    )
  }

  // The secondary sidebar: per-file AI, comments, inspect, outline and
  // proposal review for the focused group's file. It sits beside the editor
  // area — not inside a group — so a focus flip between split groups rebinds
  // it rather than moving it. Open/closed is one fact per editor scope,
  // persisted with the session: the per-file layout underneath only decides
  // which panel is in front. Its width is the resizable panel's below.
  const contextPanel =
    hasContextPanel && contextFile ? (
      <>
        <ResizableHandle withHandle />
        <ContextSidebarPanel
          id={`${panelIdPrefix}-context`}
          open={contextWorkbenchOpen}
          panelRef={contextPanelRef}
          onResize={(size) => {
            const open = size.inPixels > WORKBENCH_RAIL_WIDTH_PX + 8
            if (open) {
              lastContextWidthRef.current = size.inPixels
              setContextPanelMode(
                size.inPixels > CONTEXT_WORKBENCH_DEFAULT_WIDTH + 24 ? "wide" : "narrow"
              )
            }
            // A drag across the collapse threshold is an open/close too.
            if (open !== contextWorkbenchOpen) setContextWorkbenchOpen(open)
          }}
        >
          <ProjectContextWorkbench
            scopeKey={editor.scopeKey}
            rootPath={rootPath}
            file={contextFile}
            onDraftChange={(content) => setDraft(contextFile.relPath, content)}
            selection={editorSelection}
            railOnly={!contextWorkbenchOpen}
            onCollapse={() => setContextWorkbenchOpen(false)}
            onEnsureVisible={() => setContextWorkbenchOpen(true)}
            onModeWidthHint={hintContextWidth}
            resolvedMode={contextPanelMode}
          />
        </ContextSidebarPanel>
      </>
    ) : null

  const editorPane = (
    <ResizablePanel
      id={`${panelIdPrefix}-editor`}
      minSize="30%"
      className="min-h-0 min-w-0 overflow-hidden"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 min-w-0 flex-1">
          {splitVisible ? (
            <ResizablePanelGroup orientation="horizontal" className="h-full">
              <ResizablePanel
                id={`${panelIdPrefix}-group-0`}
                minSize="15%"
                className="min-h-0 min-w-0"
              >
                {renderGroupPane(0)}
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel
                id={`${panelIdPrefix}-group-1`}
                minSize="15%"
                className="min-h-0 min-w-0"
              >
                {renderGroupPane(1)}
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            renderGroupPane(0)
          )}
        </div>
        {problemsVisible && !zen ? (
          <ProjectProblemsPanel
            monaco={monacoNamespace}
            rootPath={rootPath}
            onNavigate={(relPath, line, column) => gotoLine(relPath, line, column)}
            onClose={() => setProblemsVisible(false)}
            onAddToChat={stageMarkerToChat}
            onAddMarkersToChat={stageMarkersToChat}
          />
        ) : null}
        {zen ? null : statusBar}
      </div>
    </ResizablePanel>
  )

  return (
    <>
      <ResizablePanelGroup
        orientation="horizontal"
        className="h-full min-h-0 min-w-0 overflow-hidden"
        elementRef={workbenchRef}
      >
        {zen ? (
          editorPane
        ) : (
          <>
            {sidebar}
            <ResizableHandle withHandle />
            {editorPane}
            {contextPanel}
          </>
        )}
      </ResizablePanelGroup>
      <ProjectQuickOpen
        rootPath={rootPath}
        open={quickOpen}
        onOpenChange={setQuickOpen}
        seedQuery={quickOpenSeed}
        commands={workbenchCommands}
        openPaths={openPathsByRecency}
        activeDocument={quickOpenActiveDoc}
        deps={quickOpenDeps}
        onOpenFile={(relPath) => {
          setQuickOpen(false)
          openFromTree(relPath)
        }}
        onGoToLine={(relPath, line, column) => {
          setQuickOpen(false)
          const target = relPath ?? activePath
          if (target) gotoLine(target, line, column)
        }}
      />
      {compareDialog}
      {confirmDialog}
    </>
  )
}

/**
 * The file context workbench's panel in the editor's resizable group: a
 * sidebar that folds to the workbench's 48px activity rail and keeps its pixel
 * width while the dock around it is dragged.
 *
 * Its own component so `defaultSize` is read once per mount: the panel library
 * re-registers a panel whenever that prop changes, so a default that tracked
 * the open flag would re-register it — and drop its handle for a render — on
 * every open and close. The open flag only picks the size it first appears at.
 */
function ContextSidebarPanel({
  id,
  open,
  panelRef,
  onResize,
  children,
}: {
  id: string
  open: boolean
  panelRef: ComponentProps<typeof ResizablePanel>["panelRef"]
  onResize: NonNullable<ComponentProps<typeof ResizablePanel>["onResize"]>
  children: ReactNode
}) {
  const [defaultSize] = useState(
    () => `${open ? CONTEXT_WORKBENCH_DEFAULT_WIDTH : WORKBENCH_RAIL_WIDTH_PX}px`
  )
  return (
    <ResizablePanel
      id={id}
      collapsible
      collapsedSize={`${WORKBENCH_RAIL_WIDTH_PX}px`}
      minSize={`${CONTEXT_WORKBENCH_MIN_WIDTH}px`}
      maxSize={`${CONTEXT_PANEL_MAX_PERCENT}%`}
      defaultSize={defaultSize}
      // Dragging the dock resizes the editor, not the sidebars.
      groupResizeBehavior="preserve-pixel-size"
      panelRef={panelRef}
      onResize={onResize}
      className="min-h-0 min-w-0"
    >
      {children}
    </ResizablePanel>
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
