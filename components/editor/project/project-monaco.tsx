"use client"

// Monaco mount for the project editor (`file` surface). Unlike the Skills /
// Canvas editors this addresses the document by its REAL `file://` URI so the
// LSP resolves it against the actual project root (cross-file navigation,
// project diagnostics). Reuses the shared workbench primitive, the shared
// surface-aware action registry, snippets, and Emmet.
//
// ONE editor instance serves every open file. Switching tabs swaps the model
// via the `path` prop; it does not remount. That is load-bearing, not a
// micro-optimisation: `@monaco-editor/react` disposes the current model on
// unmount unless `keepCurrentModel` is set, so a per-file remount destroyed the
// `ITextModel` and with it the undo/redo stack, the folding state and the LSP
// document at that URI. `keepCurrentModel` stops the destruction and
// `lib/editor-workbench/monaco-model-registry` supplies the owner that disposes
// a model when its file is actually closed.
//
// The consequence for this component is that props change *underneath* a live
// editor. Anything registered against the editor instance therefore lives in an
// effect keyed by what it actually depends on, and long-lived listeners read
// their callbacks through refs so they never see a stale prop.

import { useEffect, useRef, useState } from "react"
import Editor, { type OnMount } from "@monaco-editor/react"
import { useMonacoActiveTheme } from "@/hooks/git/use-monaco-active-theme"
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import {
  buildWorkbenchUri,
  mountMonacoWorkbench,
  type IMonacoEditor,
  type MonacoNamespace,
  type MonacoWorkbenchHandle,
} from "@/lib/editor-workbench/monaco-workbench"
import {
  bindMonacoModelRegistry,
  type ModelRegistryMonaco,
} from "@/lib/editor-workbench/monaco-model-registry"
import {
  registerEditorActions,
  type EditorActionDef,
  type EditorActionDisposable,
} from "@/lib/editor-workbench/register-editor-actions"
import { registerAllSnippets, registerEmmetSupport } from "@/lib/monaco/snippets"
import { LspServerHint } from "@/components/editor/lsp-server-hint"
import { MonacoDiagnosticsBar } from "@/components/editor/monaco-diagnostics-bar"
import type { MonacoLike, EditorLike } from "@/hooks/use-monaco-markers"
import type { OpenFile } from "./use-project-editor"
import {
  consumeProjectEditorGoto,
  PROJECT_EDITOR_GOTO_EVENT,
  type ProjectEditorGotoDetail,
} from "./editor-events"
import type { TextSelectionCoordinates } from "@/types/context-workbench"

interface RevealableEditor {
  revealLineInCenter(line: number): void
  setPosition(pos: { lineNumber: number; column: number }): void
  focus(): void
  getModel(): { getOffsetAt(position: { lineNumber: number; column: number }): number } | null
  getPosition?(): { lineNumber: number; column: number } | null
  getVisibleRanges?(): Array<{
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }>
  onDidChangeCursorSelection(listener: (event: CursorSelectionEvent) => void): { dispose(): void }
}

interface CursorSelectionEvent {
  selection: {
    getStartPosition(): { lineNumber: number; column: number }
    getEndPosition(): { lineNumber: number; column: number }
  }
}

interface Props {
  file: OpenFile
  projectRoot: string
  onChange: (next: string) => void
  /** Surface-specific actions (closures over the orchestrator's handlers). */
  actions: EditorActionDef[]
  /** actionId → localized label. */
  actionLabels: Record<string, string>
  /** User keybindings from the canvas keybinding store. */
  bindings: Record<string, string>
  onSelectionChange?: (selection: TextSelectionCoordinates | undefined) => void
  /** Caret line/column for the status bar; null when the editor loses focus context. */
  onCursorChange?: (position: { lineNumber: number; column: number } | null) => void
  onDiagnosticsReady?: (
    relPath: string,
    diagnostics: { monaco: MonacoLike; editor: EditorLike } | null
  ) => void
  /** Minimap visibility — toggled by the workbench command palette. */
  minimap?: boolean
  /** Word wrap for this model (⌥Z toggles per file, like VS Code). */
  wordWrap?: boolean
  /** Editor font size — ⌘= / ⌘- / ⌘0 zoom on the workbench. */
  fontSize?: number
  /**
   * Language-mode override from the status-bar picker ("Select Language
   * Mode"). Falls back to the extension-derived `file.monacoLanguage`.
   * `@monaco-editor/react` applies prop changes to the live model via
   * `setModelLanguage`, and a fresh mount honors it too.
   */
  language?: string
}

export function ProjectMonaco({
  file,
  projectRoot,
  onChange,
  actions,
  actionLabels,
  bindings,
  onSelectionChange,
  onCursorChange,
  onDiagnosticsReady,
  minimap = true,
  wordWrap = false,
  fontSize = 13,
  language,
}: Props) {
  // Shared theme path (DiffViewer, BlameView use the same hook): it keeps
  // re-syncing on palette/light-dark changes *after* mount, which the old
  // one-shot onMount sync could not do.
  const { themeId, registerMonaco } = useMonacoActiveTheme()
  const handleRef = useRef<MonacoWorkbenchHandle | null>(null)
  const actionDisposablesRef = useRef<EditorActionDisposable[]>([])
  const editorRef = useRef<RevealableEditor | null>(null)
  const rawEditorRef = useRef<IMonacoEditor | null>(null)
  const monacoRef = useRef<MonacoNamespace | null>(null)
  const [diag, setDiag] = useState<{ monaco: MonacoLike; editor: EditorLike } | null>(null)
  const nesDocumentRef = useRef<{ uri: string; version: number; savedContent: string } | null>(null)

  // Latest-value refs for everything read by a listener or an effect that must
  // not re-run when the value changes. Synced in an effect declared *first*, so
  // the effects below always read this render's values.
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onCursorChangeRef = useRef(onCursorChange)
  const onDiagnosticsReadyRef = useRef(onDiagnosticsReady)
  const actionsRef = useRef(actions)
  const actionLabelsRef = useRef(actionLabels)
  const bindingsRef = useRef(bindings)
  const languageRef = useRef(language)
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange
    onCursorChangeRef.current = onCursorChange
    onDiagnosticsReadyRef.current = onDiagnosticsReady
    actionsRef.current = actions
    actionLabelsRef.current = actionLabels
    bindingsRef.current = bindings
    languageRef.current = language
  })

  // Status-bar "Select Language Mode" wins over the extension-derived id.
  // Render-phase uses the prop directly (live switch via `setModelLanguage`);
  // mount-time effect reads go through `languageRef` so a late override is
  // honored without churning the workbench-handle effect's deps.
  const effectiveLanguage = language ?? file.monacoLanguage

  // The `file://` URI is both the model key handed to `<Editor path>` and the
  // identity the LSP bridge addresses — one derivation so they cannot drift.
  // `monacoLanguage` is the full-fidelity id (`rust`, `go`, `html`, …) so the
  // model gets real highlighting and didOpen a truthful `languageId`; the
  // closed `file.language` union stays for the CodeMirror side.
  const modelUri = buildWorkbenchUri({
    surface: "file",
    documentId: file.relPath,
    absolutePath: file.absolutePath,
    language: effectiveLanguage,
    initialContent: file.draftContent,
  })

  // Publish the Project Editor lifecycle only to ACP sessions that explicitly
  // started NES through the manager. Full-content changes are valid ACP/LSP
  // changes and avoid lossy range reconstruction across Monaco model swaps.
  useEffect(() => {
    if (!diag) return
    const manager = getExternalAgentManager()
    const document = {
      uri: modelUri,
      version: file.draftVersion,
      savedContent: file.savedContent,
    }
    nesDocumentRef.current = document
    manager.publishDidOpenDocument({
      uri: modelUri,
      languageId: languageRef.current ?? file.monacoLanguage,
      version: file.draftVersion,
      text: file.draftContent,
    })
    const editor = editorRef.current
    const position = editor?.getPosition?.() ?? { lineNumber: 1, column: 1 }
    const visible = editor?.getVisibleRanges?.()[0] ?? {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    }
    manager.publishDidFocusDocument({
      uri: modelUri,
      version: file.draftVersion,
      position: { line: position.lineNumber - 1, character: position.column - 1 },
      visibleRange: {
        start: { line: visible.startLineNumber - 1, character: visible.startColumn - 1 },
        end: { line: visible.endLineNumber - 1, character: visible.endColumn - 1 },
      },
    })
    return () => {
      manager.publishDidCloseDocument({ uri: modelUri })
      if (nesDocumentRef.current?.uri === modelUri) nesDocumentRef.current = null
    }
    // Content/version changes are emitted by the incremental effect below;
    // including them here would turn every keystroke into close+open churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diag, file.monacoLanguage, modelUri])

  useEffect(() => {
    const previous = nesDocumentRef.current
    if (!diag || !previous || previous.uri !== modelUri) return
    if (previous.version !== file.draftVersion) {
      getExternalAgentManager().publishDidChangeDocument({
        uri: modelUri,
        version: file.draftVersion,
        contentChanges: [{ text: file.draftContent }],
      })
      previous.version = file.draftVersion
    }
    if (previous.savedContent !== file.savedContent) {
      getExternalAgentManager().publishDidSaveDocument({ uri: modelUri })
      previous.savedContent = file.savedContent
    }
  }, [diag, file.draftContent, file.draftVersion, file.savedContent, modelUri])

  // Editor-lifetime teardown. The workbench handle and the action disposables
  // have their own per-file effects below; this only catches an unmount that
  // happens between renders.
  useEffect(() => {
    return () => {
      handleRef.current?.dispose()
      handleRef.current = null
      actionDisposablesRef.current.forEach((d) => d.dispose())
      actionDisposablesRef.current = []
    }
  }, [])

  // Reveal a line/column when the orchestrator asks for this file (search jump,
  // terminal path-link). Two delivery paths converge here: the live event
  // reaches an already-mounted editor, while `consumeProjectEditorGoto`
  // drains requests that were armed before Monaco finished loading — without
  // it a cold open's goto silently dropped.
  useEffect(() => {
    const reveal = (detail: ProjectEditorGotoDetail) => {
      if (detail.relPath !== file.relPath) return
      const ed = editorRef.current
      if (!ed) return
      ed.revealLineInCenter(detail.line)
      ed.setPosition({ lineNumber: detail.line, column: detail.column })
      ed.focus()
    }
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ProjectEditorGotoDetail>).detail
      if (!detail) return
      // The live event consumed the request — don't let its armed twin
      // re-apply the same jump on a later mount.
      consumeProjectEditorGoto(detail.relPath)
      reveal(detail)
    }
    window.addEventListener(PROJECT_EDITOR_GOTO_EVENT, handler as EventListener)
    const pending = consumeProjectEditorGoto(file.relPath)
    if (pending) reveal(pending)
    return () => window.removeEventListener(PROJECT_EDITOR_GOTO_EVENT, handler as EventListener)
  }, [file.relPath, diag])

  // Rebind the LSP / vscode-shim document every time the open file changes.
  // `draftContent` is deliberately not a dep: it only seeds a model that does
  // not exist yet, and re-running this on every keystroke would churn the
  // bridge registration.
  useEffect(() => {
    const editor = rawEditorRef.current
    const monaco = monacoRef.current
    const diagnostics = diag
    if (!editor || !monaco || !diagnostics) return
    const relPath = file.relPath
    const handle = mountMonacoWorkbench(editor, monaco, {
      surface: "file",
      documentId: relPath,
      absolutePath: file.absolutePath,
      projectRoot,
      language: languageRef.current ?? file.monacoLanguage,
      initialContent: file.draftContent,
    })
    handleRef.current = handle
    onDiagnosticsReadyRef.current?.(relPath, diagnostics)
    // Model swaps keep the caret wherever Monaco left it — re-emit so the
    // status bar does not show the previous file's position on the new one.
    const revealable = editor as unknown as RevealableEditor
    onCursorChangeRef.current?.(revealable.getPosition?.() ?? null)
    return () => {
      handle.dispose()
      handleRef.current = null
      onDiagnosticsReadyRef.current?.(relPath, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diag, file.relPath, file.absolutePath, file.monacoLanguage, projectRoot])

  // Editor actions carry per-file closures (save target, copy-path). Re-attach
  // them at the same cadence the old per-file remount did — once per open
  // document — reading the current props through refs so a keystroke-driven
  // `actions` identity change cannot thrash the registration.
  useEffect(() => {
    const editor = rawEditorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco || !diag) return
    const disposables = registerEditorActions(
      editor as unknown as Parameters<typeof registerEditorActions>[0],
      monaco as unknown as Parameters<typeof registerEditorActions>[1],
      {
        idPrefix: "file.kb.",
        triggerSource: "project-editor",
        bindings: bindingsRef.current,
        labels: actionLabelsRef.current,
        actions: actionsRef.current,
        includePluginCommands: true,
      }
    )
    actionDisposablesRef.current = disposables
    return () => {
      disposables.forEach((d) => d.dispose())
      actionDisposablesRef.current = []
    }
  }, [diag, file.absolutePath])

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor as unknown as RevealableEditor
    rawEditorRef.current = editor as unknown as IMonacoEditor
    monacoRef.current = monaco as unknown as MonacoNamespace
    // Hand the model registry a live namespace so it can dispose models whose
    // file was closed — including any close that happened before this mount.
    bindMonacoModelRegistry(monaco as unknown as ModelRegistryMonaco)
    const revealableEditor = editor as unknown as RevealableEditor
    revealableEditor.onDidChangeCursorSelection((event) => {
      const model = revealableEditor.getModel()
      if (!model) return
      const start = model.getOffsetAt(event.selection.getStartPosition())
      const end = model.getOffsetAt(event.selection.getEndPosition())
      onSelectionChangeRef.current?.(start === end ? undefined : { kind: "text", start, end })
      onCursorChangeRef.current?.(event.selection.getEndPosition())
      const visible = revealableEditor.getVisibleRanges?.()[0]
      const document = nesDocumentRef.current
      if (visible && document) {
        const position = event.selection.getEndPosition()
        getExternalAgentManager().publishDidFocusDocument({
          uri: document.uri,
          version: document.version,
          position: { line: position.lineNumber - 1, character: position.column - 1 },
          visibleRange: {
            start: { line: visible.startLineNumber - 1, character: visible.startColumn - 1 },
            end: { line: visible.endLineNumber - 1, character: visible.endColumn - 1 },
          },
        })
      }
    })
    const nextDiagnostics = {
      monaco: monaco as unknown as MonacoLike,
      editor: editor as unknown as EditorLike,
    }
    setDiag(nextDiagnostics)
    // registerMonaco both applies the theme now (the `theme` prop alone can
    // fire before the theme is defined) and stores the instance so the hook
    // keeps it in sync on palette/light-dark changes.
    registerMonaco(monaco as unknown as Parameters<typeof registerMonaco>[0])

    // Snippets / Emmet are global-per-Monaco-instance and idempotent.
    registerAllSnippets(monaco)
    registerEmmetSupport(monaco)
  }

  return (
    <div className="flex h-full flex-col">
      <LspServerHint language={file.language} />
      <div className="min-h-0 flex-1">
        <Editor
          // `path` swaps the model instead of remounting the editor, and
          // `keepCurrentModel` stops the library from disposing it — together
          // they are what keeps the undo stack alive across a tab switch. The
          // model registry owns the eventual disposal.
          path={modelUri}
          keepCurrentModel
          value={file.draftContent}
          language={effectiveLanguage}
          theme={themeId}
          options={{
            minimap: { enabled: minimap },
            fontSize,
            wordWrap: wordWrap ? "on" : "off",
            scrollBeyondLastLine: false,
            renderWhitespace: "selection",
            automaticLayout: true,
            // VS Code defaults the dock is missing: hover/find widgets must
            // escape the narrow pane, the sticky header keeps scope visible
            // in long files, and smooth scrolling/caret match the feel.
            fixedOverflowWidgets: true,
            stickyScroll: { enabled: true },
            smoothScrolling: true,
            cursorSmoothCaretAnimation: "on",
            padding: { top: 8 },
          }}
          onChange={(v) => onChange(v ?? "")}
          onMount={handleMount}
          height="100%"
        />
      </div>
      {!onDiagnosticsReady ? (
        <MonacoDiagnosticsBar monaco={diag?.monaco ?? null} editor={diag?.editor ?? null} />
      ) : null}
    </div>
  )
}
