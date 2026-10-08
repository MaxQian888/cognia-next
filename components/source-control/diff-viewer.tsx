"use client"

/**
 * DiffViewer — one file's diff with a single toolbar above it.
 *
 * Body: the Monaco `DiffEditor` for ordinary files on desktop. A phone, and a
 * diff past the Monaco budget (`diffPresentation`), get the virtualized
 * {@link LineDiffView} instead — a line diff of the full texts, folded and
 * expandable, or the git hunks when the host left the texts out
 * (`contentOmitted`). A large diff keeps "Load full diff" into Monaco; an
 * omitted one can ask the host to rebuild its texts (`onLoadOmitted`). A
 * phone never mounts Monaco: two ~180px columns are no diff, and the model
 * plus its workers are the heaviest thing a review could load there.
 *
 * Editing: with `edit`, the modified side of a working-tree diff is editable
 * in Monaco. Unsaved text lives in the git store (`diffEdits`), so switching
 * files or leaving the review keeps it; while it is unsaved, Monaco keeps the
 * disk text it started from, so a refresh of the diff never replaces the
 * buffer, and a disk text that moved on underneath is called out. Save
 * (Ctrl/⌘+S) checks the disk is still what the edit started from before it
 * writes, and asks before overwriting.
 *
 * Toolbar (only when there is something to put in it): the host's leading
 * slot (file identity / navigation), a current-change navigator whose
 * Stage / Unstage / Discard buttons act on the change the reader is on, the
 * view menu (inline vs side-by-side, collapse unchanged, wrap, whitespace) and
 * the host's trailing slot. The navigator replaced a row of one chip per hunk,
 * which scrolled sideways past a dozen hunks and named each only by "@@ 214".
 * Alt+F5 / Shift+Alt+F5 move between changes from anywhere in the viewer,
 * Monaco included (VS Code's chords for the same thing).
 *
 * Reuses the Canvas Monaco setup: `configureMonacoLoader` (offline assets),
 * `automaticLayout: true` so Monaco sizes itself once the container has
 * dimensions (the editor mounts async via `dynamic`, so a manual size-on-mount
 * would race), plus the ResizeObserver `layout()` backstop for the flex-shrink
 * bug (microsoft/monaco-editor#3393).
 */

import {
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react"
import dynamic from "next/dynamic"
import type { editor as MonacoEditor, IDisposable } from "monaco-editor"
import { useTranslations } from "next-intl"
import {
  ChevronDownIcon,
  ChevronUpIcon,
  FileQuestionIcon,
  FileSearchIcon,
  SaveIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  Undo2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LineDiffView, type LineDiffViewHandle } from "@/components/diff/line-diff-view"
import { useElementWidth } from "@/hooks/use-element-width"
import { useMonacoActiveTheme } from "@/hooks/git/use-monaco-active-theme"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"
import { computeDiff } from "@/lib/artifacts/diff"
import { guardDiffEditorModelDisposal } from "@/lib/canvas/monaco-diff-disposal"
import { diffPresentation, gitHunksToDiffRows, hunkIndexAtLine } from "@/lib/git/diff-presentation"
import type { DiffViewMode } from "@/lib/git/panel-prefs"
import { cn } from "@/lib/utils"
import { useGitStore } from "@/stores/git/git-store"
import type { GitDiff } from "@/types/git"
import { HUNK_ACTION_ICON, type HunkAction } from "./hunk-actions"

const MonacoDiff = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), {
  ssr: false,
  loading: () => <DiffLoading />,
})

/**
 * Below this width the lightweight view reads inline even when the reader
 * prefers side by side — Monaco's own `useInlineViewWhenSpaceIsLimited`
 * makes the same call for the editor view.
 */
export const LINES_SPLIT_MIN_WIDTH = 640

/** Typing settles into the draft store after this long without a key. */
const DRAFT_DEBOUNCE_MS = 150

/**
 * The "loading diff" placeholder. Exported so `DiffPane` can show the same
 * line while it fetches, instead of mounting the viewer with no diff (which
 * this component reads as "nothing selected").
 */
export function DiffLoading() {
  const t = useTranslations("sourceControl")
  return (
    // The region announces, not the glyph: the label beside it is already the
    // message, so a second live region on the spinner would say it twice.
    <div
      role="status"
      className="flex h-full items-center justify-center bg-muted/20 text-sm text-muted-foreground"
    >
      <Spinner className="mr-2 size-4" />
      {t("diff.loading")}
    </div>
  )
}

export type { HunkAction } from "./hunk-actions"

/** What a save attempt came to; failures reject instead. */
export type DiffSaveOutcome = "saved" | "conflict"

/** Wiring for editing the modified side (working-tree diffs). */
export interface DiffEditBinding {
  /** Store key for the unsaved text (`diffEditKey(rootDir, path)`). */
  draftKey: string
  /**
   * Write `content`. With `expectedDisk`, resolve `"conflict"` without writing
   * when the file on disk is no longer that text; `null` overwrites.
   */
  save: (content: string, expectedDisk: string | null) => Promise<DiffSaveOutcome>
}

/** Imperative handle: bring a hunk into view, as the navigator does. */
export interface DiffViewerHandle {
  revealHunk: (index: number) => void
}

interface DiffViewerProps {
  ref?: Ref<DiffViewerHandle>
  diff: GitDiff | null
  /** Whether the diff represents staged (HEAD↔index) content. */
  staged: boolean
  /** Actions on the current change, shown beside the change navigator. */
  hunkActions?: HunkAction[]
  /** Read-only original side (always true here — the original is git's). */
  readOnly?: boolean
  density?: "compact" | "touch"
  /** Leading toolbar content from the host (file identity, file navigation). */
  toolbarStart?: ReactNode
  /** Trailing toolbar content from the host (its own actions). */
  toolbarEnd?: ReactNode
  /**
   * Open the file at a modified-side line. Enables "open at this change" in
   * the toolbar and the line-number gutter of the lightweight view.
   */
  onOpenLine?: (line: number) => void
  /** Make the modified side editable; honoured for unstaged diffs in Monaco. */
  edit?: DiffEditBinding
  /** Ask the host to rebuild the full texts of a `contentOmitted` diff. */
  onLoadOmitted?: () => Promise<void>
  /**
   * The change the reader is on (index into `diff.hunks`, `-1` for none) —
   * for a host list that should follow the viewer, like the hunk review.
   */
  onCurrentChange?: (index: number) => void
}

/** Alt+F5 → +1, Shift+Alt+F5 → -1, anything else → 0. */
function changeStep(event: { key: string; altKey: boolean; shiftKey: boolean }): -1 | 0 | 1 {
  if (event.key !== "F5" || !event.altKey) return 0
  return event.shiftKey ? -1 : 1
}

export function DiffViewer({
  ref,
  diff,
  staged,
  hunkActions = [],
  density = "compact",
  toolbarStart,
  toolbarEnd,
  onOpenLine,
  edit,
  onLoadOmitted,
  onCurrentChange,
}: DiffViewerProps) {
  const t = useTranslations("sourceControl")
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null)
  const lineDiffRef = useRef<LineDiffViewHandle | null>(null)
  const disposablesRef = useRef<IDisposable[]>([])
  const { themeId, registerMonaco } = useMonacoActiveTheme()
  const { prefs, setDiffView, setCollapseUnchanged, setDiffWordWrap, setIgnoreWhitespace } =
    useSourceControlPrefs()
  const touch = density === "touch"
  const bodyWidth = useElementWidth(containerRef)

  const hunks = useMemo(() => (diff && !diff.isBinary ? diff.hunks : []), [diff])
  const presentation = useMemo(
    () => (diff && !diff.isBinary ? diffPresentation(diff) : "monaco"),
    [diff]
  )
  // "Load full diff" on a large file, for this path only: the pane keeps one
  // viewer across file switches, so the choice is dropped when the path moves.
  const [fullFor, setFullFor] = useState<string | null>(null)
  const path = diff?.path ?? null
  const view: "monaco" | "lines" =
    !touch && (presentation === "monaco" || (presentation === "large" && fullFor === path))
      ? "monaco"
      : "lines"

  // The lightweight view diffs the full texts when it has them (every line
  // there, folded and expandable); without them, the hunks are all there is.
  const hasTexts = Boolean(diff && !diff.isBinary && !diff.contentOmitted)
  const lineDiff = useMemo(
    () =>
      view === "lines" && hasTexts && diff
        ? computeDiff(diff.oldContent, diff.newContent, {
            ignoreTrimWhitespace: prefs.ignoreWhitespace,
          })
        : undefined,
    [view, hasTexts, diff, prefs.ignoreWhitespace]
  )
  const lineRows = useMemo(
    () =>
      view === "lines" && !hasTexts && hunks.length > 0 ? gitHunksToDiffRows(hunks) : undefined,
    [view, hasTexts, hunks]
  )
  const linesLayout =
    !touch && prefs.diffView === "sideBySide" && bodyWidth >= LINES_SPLIT_MIN_WIDTH
      ? "split"
      : "unified"

  // ── Rebuilding an omitted diff's texts ─────────────────────────────────
  const [omittedLoad, setOmittedLoad] = useState<{
    path: string | null
    state: "loading" | "failed"
  } | null>(null)
  const omittedState = omittedLoad?.path === path ? omittedLoad.state : null
  const loadOmitted = useCallback(async () => {
    if (!onLoadOmitted) return
    setOmittedLoad({ path, state: "loading" })
    try {
      await onLoadOmitted()
      setOmittedLoad(null)
    } catch {
      setOmittedLoad({ path, state: "failed" })
    }
  }, [onLoadOmitted, path])

  // The change the reader is on. Follows the Monaco caret; set directly by
  // the navigator in the lightweight view, which has no caret.
  const [current, setCurrent] = useState(-1)
  const [currentFor, setCurrentFor] = useState<string | null>(path)
  if (currentFor !== path) {
    setCurrentFor(path)
    setCurrent(-1)
  }
  const currentHunk = current >= 0 && current < hunks.length ? hunks[current] : null
  const hunksRef = useRef(hunks)
  useEffect(() => {
    hunksRef.current = hunks
  }, [hunks])

  // ── Editing the modified side ──────────────────────────────────────────
  const editable = Boolean(edit) && !staged && view === "monaco" && !touch
  const draftKey = edit?.draftKey ?? null
  const draft = useGitStore((s) => (draftKey ? s.diffEdits[draftKey] : undefined))
  const setDiffEdit = useGitStore((s) => s.setDiffEdit)
  // A save that landed before the refreshed diff did: Monaco keeps the saved
  // text until the diff stops showing the disk as it was before the save.
  const [justSaved, setJustSaved] = useState<{
    key: string
    text: string
    before: string
  } | null>(null)
  const savedText =
    justSaved && justSaved.key === draftKey && diff?.newContent === justSaved.before
      ? justSaved.text
      : null
  const modifiedText = editable
    ? (draft?.base ?? savedText ?? diff?.newContent ?? "")
    : (diff?.newContent ?? "")
  const dirty = editable && draft !== undefined
  // The file moved on underneath unsaved edits.
  const diskMoved =
    editable && draft !== undefined && diff !== null && diff.newContent !== draft.base
  const [saving, setSaving] = useState(false)
  const [saveIssue, setSaveIssue] = useState<{ key: string; kind: "conflict" | "failed" } | null>(
    null
  )
  const issue = saveIssue?.key === draftKey ? saveIssue.kind : null

  // Refs the Monaco listeners read; written after commit, never in render.
  const draftKeyRef = useRef(draftKey)
  const baseRef = useRef(modifiedText)
  const editableRef = useRef(editable)
  const pendingDraft = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Settle the buffer into the draft store, for the file it was typed in. */
  const writeDraft = useCallback(() => {
    const key = draftKeyRef.current
    const modified = editorRef.current?.getModifiedEditor?.()
    if (!key || !modified) return
    let content: string
    try {
      content = modified.getValue()
    } catch {
      // The editor was disposed under us; there is no buffer left to keep.
      return
    }
    const stored = useGitStore.getState().diffEdits[key]
    const base = stored?.base ?? baseRef.current
    setDiffEdit(key, content === base ? null : { content, base })
  }, [setDiffEdit])

  /** Write a pending (still debouncing) draft now; a no-op when none is. */
  const flushDraft = useCallback(() => {
    if (!pendingDraft.current) return
    clearTimeout(pendingDraft.current)
    pendingDraft.current = null
    writeDraft()
  }, [writeDraft])

  // Layout effects run before Monaco's own (passive) sync of the `modified`
  // prop, so a pending draft is flushed against the file it was typed in
  // before the next file's text replaces the buffer.
  useLayoutEffect(() => {
    flushDraft()
    draftKeyRef.current = draftKey
    baseRef.current = modifiedText
    editableRef.current = editable
  }, [draftKey, modifiedText, editable, flushDraft])

  useEffect(() => () => flushDraft(), [flushDraft])

  // Coming back to a file with unsaved text: Monaco has been handed its base;
  // put the edits back on top.
  const [editorReady, setEditorReady] = useState(false)
  // The lightweight view has no editor; a later switch back to Monaco mounts
  // a new one and reports ready again.
  const [readyForView, setReadyForView] = useState(view)
  if (readyForView !== view) {
    setReadyForView(view)
    if (editorReady) setEditorReady(false)
  }
  useEffect(() => {
    if (!editable || !editorReady || !draftKey) return
    const stored = useGitStore.getState().diffEdits[draftKey]
    const modified = editorRef.current?.getModifiedEditor?.()
    const model = modified?.getModel?.()
    if (!stored || !modified || !model || modified.getValue() === stored.content) return
    modified.executeEdits("cognia.diff.restoreDraft", [
      { range: model.getFullModelRange(), text: stored.content, forceMoveMarkers: true },
    ])
  }, [editable, editorReady, draftKey])

  /** Put the buffer back to `text` and drop the draft. */
  const resetBuffer = useCallback(
    (text: string) => {
      if (pendingDraft.current) {
        clearTimeout(pendingDraft.current)
        pendingDraft.current = null
      }
      const modified = editorRef.current?.getModifiedEditor?.()
      const model = modified?.getModel?.()
      if (modified && model && modified.getValue() !== text) {
        modified.executeEdits("cognia.diff.revert", [
          { range: model.getFullModelRange(), text, forceMoveMarkers: true },
        ])
      }
      if (draftKey) setDiffEdit(draftKey, null)
      setSaveIssue(null)
    },
    [draftKey, setDiffEdit]
  )

  const save = useCallback(
    async (force = false) => {
      if (!edit || !editableRef.current || !draftKey || !diff) return
      flushDraft()
      const modified = editorRef.current?.getModifiedEditor?.()
      if (!modified) return
      const content = modified.getValue()
      const stored = useGitStore.getState().diffEdits[draftKey]
      if (!stored && !force) return
      const expected = force ? null : (stored?.base ?? diff.newContent)
      setSaving(true)
      setSaveIssue(null)
      try {
        const outcome = await edit.save(content, expected)
        if (outcome === "conflict") {
          setSaveIssue({ key: draftKey, kind: "conflict" })
          return
        }
        setJustSaved({ key: draftKey, text: content, before: diff.newContent })
        setDiffEdit(draftKey, null)
      } catch {
        setSaveIssue({ key: draftKey, kind: "failed" })
      } finally {
        setSaving(false)
      }
    },
    [edit, draftKey, diff, flushDraft, setDiffEdit]
  )
  const saveRef = useRef(save)
  const writeDraftRef = useRef(writeDraft)
  useEffect(() => {
    saveRef.current = save
    writeDraftRef.current = writeDraft
  }, [save, writeDraft])

  const revealHunk = useCallback(
    (index: number) => {
      const hunk = hunks[index]
      if (!hunk) return
      setCurrent(index)
      if (view === "lines") {
        lineDiffRef.current?.revealLine({ side: "new", line: hunk.newStart })
        return
      }
      const modified = editorRef.current?.getModifiedEditor()
      if (!modified) return
      modified.revealLineInCenter(hunk.newStart)
      modified.setPosition({ lineNumber: hunk.newStart, column: 1 })
      modified.focus()
    },
    [hunks, view]
  )

  const step = useCallback(
    (delta: -1 | 1) => {
      if (hunks.length === 0) return
      const from = current < 0 ? (delta > 0 ? -1 : hunks.length) : current
      const next = Math.min(hunks.length - 1, Math.max(0, from + delta))
      revealHunk(next)
    },
    [current, hunks.length, revealHunk]
  )
  const stepRef = useRef(step)
  useEffect(() => {
    stepRef.current = step
  }, [step])

  useImperativeHandle(ref, () => ({ revealHunk }), [revealHunk])
  useEffect(() => {
    onCurrentChange?.(currentHunk ? current : -1)
  }, [onCurrentChange, current, currentHunk])

  // Flex-shrink layout fix (see canvas-panel.tsx for the rationale).
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === "undefined") return
    let pending: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        editorRef.current?.layout()
      }, 60)
    })
    observer.observe(container)
    return () => {
      if (pending) clearTimeout(pending)
      observer.disconnect()
    }
  }, [])

  useEffect(
    () => () => {
      for (const d of disposablesRef.current) d.dispose()
      disposablesRef.current = []
    },
    []
  )
  // The lightweight view has no editor: nothing may reach the disposed one.
  useEffect(() => {
    if (view !== "monaco") editorRef.current = null
  }, [view])

  // Monaco calls `onMount` once per editor; everything it wires reads the
  // latest values through refs, so the callback itself never has to change.
  const mountDeps = useRef({ registerMonaco, t })
  useEffect(() => {
    mountDeps.current = { registerMonaco, t }
  }, [registerMonaco, t])

  const onMount = useCallback(
    (editor: MonacoEditor.IStandaloneDiffEditor, monaco: typeof import("monaco-editor")) => {
      const { registerMonaco, t } = mountDeps.current
      for (const d of disposablesRef.current) d.dispose()
      disposablesRef.current = []
      editorRef.current = editor
      guardDiffEditorModelDisposal(editor)
      registerMonaco(monaco)
      const modified = editor.getModifiedEditor?.()
      if (!modified) return
      // The caret is the reader's position: follow it to the change it is in.
      if (typeof modified.onDidChangeCursorPosition === "function") {
        disposablesRef.current.push(
          modified.onDidChangeCursorPosition((e) => {
            setCurrent(hunkIndexAtLine(hunksRef.current, e.position.lineNumber))
          })
        )
      }
      // What the reader types. Monaco's own sync of a new `modified` prop
      // also edits the model, but never while the reader is in the editor:
      // only an edit with focus there is the reader's.
      if (typeof modified.onDidChangeModelContent === "function") {
        disposablesRef.current.push(
          modified.onDidChangeModelContent(() => {
            if (!editableRef.current) return
            if (!(modified.hasTextFocus?.() || modified.hasWidgetFocus?.())) return
            if (pendingDraft.current) clearTimeout(pendingDraft.current)
            pendingDraft.current = setTimeout(() => {
              pendingDraft.current = null
              writeDraftRef.current()
            }, DRAFT_DEBOUNCE_MS)
          })
        )
      }
      // Same chords inside the editor, where Monaco keeps the key events.
      const KeyMod = monaco?.KeyMod
      const KeyCode = monaco?.KeyCode
      if (KeyMod && KeyCode) {
        for (const target of [modified, editor.getOriginalEditor?.()]) {
          if (!target || typeof target.addAction !== "function") continue
          disposablesRef.current.push(
            target.addAction({
              id: "cognia.diff.nextChange",
              label: t("diff.nav.next"),
              keybindings: [KeyMod.Alt | KeyCode.F5],
              run: () => stepRef.current(1),
            }),
            target.addAction({
              id: "cognia.diff.previousChange",
              label: t("diff.nav.prev"),
              keybindings: [KeyMod.Shift | KeyMod.Alt | KeyCode.F5],
              run: () => stepRef.current(-1),
            })
          )
        }
        if (typeof modified.addAction === "function" && KeyCode.KeyS !== undefined) {
          disposablesRef.current.push(
            modified.addAction({
              id: "cognia.diff.save",
              label: t("diff.edit.save"),
              keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS],
              run: () => void saveRef.current(),
            })
          )
        }
      }
      setEditorReady(true)
    },
    []
  )

  const options = useMemo<MonacoEditor.IStandaloneDiffEditorConstructionOptions>(
    () => ({
      readOnly: !editable,
      originalEditable: false,
      // View mode + whitespace handling are user preferences (gear popover /
      // the toolbar's view menu).
      renderSideBySide: prefs.diffView === "sideBySide",
      useInlineViewWhenSpaceIsLimited: true,
      ignoreTrimWhitespace: prefs.ignoreWhitespace,
      hideUnchangedRegions: { enabled: prefs.collapseUnchanged },
      wordWrap: prefs.diffWordWrap ? "on" : "off",
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      renderOverviewRuler: false,
    }),
    [editable, prefs.diffView, prefs.ignoreWhitespace, prefs.collapseUnchanged, prefs.diffWordWrap]
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return
      const delta = changeStep(event)
      if (delta === 0) return
      event.preventDefault()
      step(delta)
    },
    [step]
  )

  const openFind = useCallback(() => {
    if (view === "lines") {
      lineDiffRef.current?.openFind()
      return
    }
    const modified = editorRef.current?.getModifiedEditor?.()
    if (!modified) return
    modified.focus()
    void modified.getAction?.("actions.find")?.run()
  }, [view])

  if (!diff) {
    return (
      <Empty className="h-full border-0" data-testid="diff-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestionIcon />
          </EmptyMedia>
          <EmptyDescription>{t("diff.selectFile")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (diff.isBinary) {
    return (
      <div className="@container/diff flex h-full min-h-0 flex-col" data-testid="diff-viewer">
        {toolbarStart || toolbarEnd ? (
          <DiffToolbar touch={touch} start={toolbarStart} end={toolbarEnd} />
        ) : null}
        <Empty className="min-h-0 flex-1 border-0" data-testid="diff-binary">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileQuestionIcon />
            </EmptyMedia>
            <EmptyDescription>{t("diff.binary")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  const iconButton = cn("text-muted-foreground", touch ? "size-11" : "size-7")
  const hasNavigator = hunks.length > 0
  const position = current >= 0 ? current + 1 : 0
  const navigator = hasNavigator ? (
    <div
      role="group"
      aria-label={t("diff.nav.label")}
      className="flex shrink-0 items-center gap-0.5"
      data-testid="hunk-nav"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={iconButton}
        onClick={() => step(-1)}
        disabled={current === 0}
        aria-label={t("diff.nav.prev")}
        title={t("diff.nav.prev")}
        aria-keyshortcuts="Shift+Alt+F5"
        data-testid="hunk-prev"
      >
        <ChevronUpIcon className="size-4" />
      </Button>
      <span
        className="min-w-[3.5ch] text-center font-mono text-[11px] text-muted-foreground tabular-nums"
        aria-live="polite"
        aria-label={
          position > 0
            ? t("diff.nav.positionLabel", { current: position, total: hunks.length })
            : t("diff.hunkCount", { count: hunks.length })
        }
        title={t("diff.hunkCount", { count: hunks.length })}
        data-testid="hunk-position"
      >
        {/* "–/7" before a change is picked: the count stays in the same
            compact slot as "3/7" instead of a wider "7 hunks". */}
        {t("diff.nav.position", { current: position > 0 ? position : "–", total: hunks.length })}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={iconButton}
        onClick={() => step(1)}
        disabled={current === hunks.length - 1}
        aria-label={t("diff.nav.next")}
        title={t("diff.nav.next")}
        aria-keyshortcuts="Alt+F5"
        data-testid="hunk-next"
      >
        <ChevronDownIcon className="size-4" />
      </Button>
      {hunkActions.length > 0 || onOpenLine ? (
        <div
          role="group"
          aria-label={t("diff.nav.actionsLabel")}
          className="ml-1 flex items-center gap-0.5 border-l pl-1"
        >
          {hunkActions.map((action) => {
            const Icon = HUNK_ACTION_ICON[action.icon]
            return (
              <Button
                key={action.icon}
                type="button"
                variant="ghost"
                size="icon"
                className={iconButton}
                aria-label={action.label}
                title={action.label}
                disabled={!currentHunk}
                onClick={() => currentHunk && action.onClick(currentHunk)}
                data-testid={`hunk-${action.icon}`}
              >
                <Icon className="size-3.5" />
              </Button>
            )
          })}
          {onOpenLine ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={iconButton}
              aria-label={t("diff.openAtChange")}
              title={t("diff.openAtChange")}
              onClick={() => onOpenLine(currentHunk?.newStart ?? hunks[0].newStart)}
              data-testid="hunk-open-in-editor"
            >
              <FileSearchIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null

  const editControls = dirty ? (
    <div
      role="group"
      aria-label={t("diff.edit.label")}
      className="flex shrink-0 items-center gap-0.5"
      data-testid="diff-edit-controls"
    >
      <span
        className="mr-0.5 size-1.5 rounded-full bg-amber-500"
        aria-hidden
        data-testid="diff-edit-dirty"
      />
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="gap-1"
        disabled={saving}
        onClick={() => void save()}
        aria-label={t("diff.edit.save")}
        title={t("diff.edit.save")}
        aria-keyshortcuts="Control+S Meta+S"
        data-testid="diff-edit-save"
      >
        {saving ? <Spinner className="size-3.5" /> : <SaveIcon className="size-3.5" />}
        <span className="hidden @2xl/diff:inline">{t("diff.edit.saveShort")}</span>
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={iconButton}
        disabled={saving}
        onClick={() => resetBuffer(diff.newContent)}
        aria-label={t("diff.edit.revert")}
        title={t("diff.edit.revert")}
        data-testid="diff-edit-revert"
      >
        <Undo2Icon className="size-3.5" />
      </Button>
    </div>
  ) : null

  const findButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={iconButton}
      onClick={openFind}
      aria-label={t("diff.find")}
      title={t("diff.find")}
      aria-keyshortcuts="Control+F Meta+F"
      data-testid="diff-find"
    >
      <SearchIcon className="size-3.5" />
    </Button>
  )

  const viewMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={iconButton}
          aria-label={t("diff.view.label")}
          title={t("diff.view.label")}
          data-testid="diff-view-menu"
        >
          <SlidersHorizontalIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {!touch ? (
          <>
            <DropdownMenuLabel className="text-xs">{t("viewSettings.diffView")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={prefs.diffView}
              onValueChange={(value) => void setDiffView(value as DiffViewMode)}
            >
              <DropdownMenuRadioItem value="sideBySide" data-testid="diff-view-side-by-side">
                {t("viewSettings.diffMode.sideBySide")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="inline" data-testid="diff-view-inline">
                {t("viewSettings.diffMode.inline")}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuCheckboxItem
          checked={prefs.collapseUnchanged}
          onCheckedChange={(checked) => void setCollapseUnchanged(checked === true)}
          data-testid="diff-view-collapse"
        >
          {t("viewSettings.collapseUnchanged")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={prefs.diffWordWrap || (touch && view === "lines")}
          // A phone always wraps: sideways scrolling is a poor gesture there.
          disabled={touch}
          onCheckedChange={(checked) => void setDiffWordWrap(checked === true)}
          data-testid="diff-view-wrap"
        >
          {t("viewSettings.diffWordWrap")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={prefs.ignoreWhitespace}
          // The hunk view shows git's hunks as they are; only a diff of the
          // full texts can re-compare lines.
          disabled={Boolean(lineRows)}
          onCheckedChange={(checked) => void setIgnoreWhitespace(checked === true)}
          data-testid="diff-view-whitespace"
        >
          {t("viewSettings.ignoreWhitespace")}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  // Client-built diffs in a fixed-height card (agent runs, delegate patches)
  // keep their whole box for the code when there is nothing to navigate.
  const showToolbar =
    hasNavigator ||
    Boolean(toolbarStart) ||
    Boolean(toolbarEnd) ||
    presentation !== "monaco" ||
    dirty
  const banner =
    presentation === "hunks-only" ? (
      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200"
        role="note"
        data-testid="diff-large-banner"
      >
        <span className="min-w-0 flex-1">
          {omittedState === "failed" ? t("diff.large.loadOmittedFailed") : t("diff.large.omitted")}
        </span>
        {onLoadOmitted ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className={cn("shrink-0 gap-1", touch && "min-h-11 px-3")}
            disabled={omittedState === "loading"}
            onClick={() => void loadOmitted()}
            data-testid="diff-load-omitted"
          >
            {omittedState === "loading" ? <Spinner className="size-3.5" /> : null}
            {t("diff.large.loadOmitted")}
          </Button>
        ) : null}
      </div>
    ) : presentation === "large" && !touch && view === "lines" ? (
      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200"
        role="note"
        data-testid="diff-large-banner"
      >
        <span className="min-w-0 flex-1">{t("diff.large.banner")}</span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0"
          onClick={() => setFullFor(path)}
          data-testid="diff-load-full"
        >
          {t("diff.large.loadFull")}
        </Button>
      </div>
    ) : null
  const editBanner =
    editable && (diskMoved || issue) ? (
      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200"
        role="alert"
        data-testid="diff-edit-banner"
        data-issue={issue ?? "diskMoved"}
      >
        <span className="min-w-0 flex-1">
          {issue === "failed"
            ? t("diff.edit.failed")
            : issue === "conflict"
              ? t("diff.edit.conflict")
              : t("diff.edit.diskMoved")}
        </span>
        {issue === "conflict" ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="shrink-0"
            disabled={saving}
            onClick={() => void save(true)}
            data-testid="diff-edit-overwrite"
          >
            {t("diff.edit.overwrite")}
          </Button>
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="shrink-0"
          disabled={saving}
          onClick={() => resetBuffer(diff.newContent)}
          data-testid="diff-edit-discard"
        >
          {t("diff.edit.discard")}
        </Button>
      </div>
    ) : null

  return (
    <div
      // Hosts size their toolbar labels against this container (`@md/diff`).
      className="@container/diff flex h-full min-h-0 flex-col"
      data-testid="diff-viewer"
      data-view={view}
      data-editable={editable ? "true" : undefined}
      onKeyDown={onKeyDown}
    >
      {showToolbar ? (
        <DiffToolbar
          touch={touch}
          start={toolbarStart}
          middle={
            editControls || navigator ? (
              <>
                {editControls}
                {navigator}
              </>
            ) : null
          }
          end={
            <>
              {findButton}
              {viewMenu}
              {toolbarEnd}
            </>
          }
        />
      ) : null}
      {banner}
      {editBanner}
      <div ref={containerRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {view === "lines" ? (
          <LineDiffView
            ref={lineDiffRef}
            rows={lineRows}
            lines={lineDiff}
            layout={linesLayout}
            wrap={prefs.diffWordWrap || touch}
            context={prefs.collapseUnchanged ? 3 : null}
            density={density}
            onOpenLine={
              onOpenLine ? (line) => onOpenLine(line.newLineNum ?? line.oldLineNum ?? 1) : undefined
            }
            aria-label={diff.path}
            data-testid="diff-lines-view"
          />
        ) : (
          <Suspense fallback={<DiffLoading />}>
            <MonacoDiff
              original={diff.oldContent}
              modified={modifiedText}
              language={diff.language ?? "plaintext"}
              theme={themeId}
              options={options}
              onMount={onMount}
            />
          </Suspense>
        )}
      </div>
    </div>
  )
}

/**
 * One row while it fits, two when it does not: the leading slot keeps a
 * readable minimum (its content truncates down to it), and the navigator and
 * trailing actions wrap together onto a second row below that — in a 480px
 * dock, a phone — instead of overlapping the file's name. Touch rows grow to
 * fit 44px targets.
 */
export function DiffToolbar({
  touch,
  start,
  middle,
  end,
}: {
  touch: boolean
  start?: ReactNode
  middle?: ReactNode
  end?: ReactNode
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-1 border-b bg-muted/20 px-1.5",
        touch ? "min-h-12 py-0.5" : "min-h-9 py-0.5"
      )}
      data-testid="diff-toolbar"
    >
      <div className="flex min-w-[min(100%,14rem)] flex-1 items-center gap-1 overflow-hidden">
        {start}
      </div>
      {middle || end ? (
        <div
          className="ml-auto flex shrink-0 items-center gap-0.5"
          data-testid="diff-toolbar-actions"
        >
          {middle}
          {end}
        </div>
      ) : null}
    </div>
  )
}
