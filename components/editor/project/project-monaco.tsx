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
import { useTheme } from "next-themes"
import { configureMonacoLoader } from "@/lib/canvas/monaco-loader"
import {
  COGNIA_ACTIVE_THEME_ID,
  syncCogniaActiveTheme,
} from "@/lib/canvas/themes/cognia-active-theme"
import { useSettingsStore } from "@/stores"
import { resolveActiveThemeColors } from "@/lib/themes"
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
import { PROJECT_EDITOR_GOTO_EVENT, type ProjectEditorGotoDetail } from "./editor-events"
import type { TextSelectionCoordinates } from "@/types/context-workbench"

interface RevealableEditor {
  revealLineInCenter(line: number): void
  setPosition(pos: { lineNumber: number; column: number }): void
  focus(): void
  getModel(): { getOffsetAt(position: { lineNumber: number; column: number }): number } | null
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
  onDiagnosticsReady?: (
    relPath: string,
    diagnostics: { monaco: MonacoLike; editor: EditorLike } | null
  ) => void
}

export function ProjectMonaco({
  file,
  projectRoot,
  onChange,
  actions,
  actionLabels,
  bindings,
  onSelectionChange,
  onDiagnosticsReady,
}: Props) {
  const { resolvedTheme } = useTheme()
  const handleRef = useRef<MonacoWorkbenchHandle | null>(null)
  const actionDisposablesRef = useRef<EditorActionDisposable[]>([])
  const editorRef = useRef<RevealableEditor | null>(null)
  const rawEditorRef = useRef<IMonacoEditor | null>(null)
  const monacoRef = useRef<MonacoNamespace | null>(null)
  const [diag, setDiag] = useState<{ monaco: MonacoLike; editor: EditorLike } | null>(null)

  // Latest-value refs for everything read by a listener or an effect that must
  // not re-run when the value changes. Synced in an effect declared *first*, so
  // the effects below always read this render's values.
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onDiagnosticsReadyRef = useRef(onDiagnosticsReady)
  const actionsRef = useRef(actions)
  const actionLabelsRef = useRef(actionLabels)
  const bindingsRef = useRef(bindings)
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange
    onDiagnosticsReadyRef.current = onDiagnosticsReady
    actionsRef.current = actions
    actionLabelsRef.current = actionLabels
    bindingsRef.current = bindings
  })

  const appearanceColorTheme = useSettingsStore((s) => s.colorTheme)
  const appearanceActiveCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const appearanceCustomThemes = useSettingsStore((s) => s.customThemes)

  // The `file://` URI is both the model key handed to `<Editor path>` and the
  // identity the LSP bridge addresses — one derivation so they cannot drift.
  const modelUri = buildWorkbenchUri({
    surface: "file",
    documentId: file.relPath,
    absolutePath: file.absolutePath,
    language: file.language,
    initialContent: file.draftContent,
  })

  useEffect(() => {
    configureMonacoLoader()
  }, [])

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
  // terminal path-link). Ignores events targeting a different file.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ProjectEditorGotoDetail>).detail
      if (!detail || detail.relPath !== file.relPath) return
      const ed = editorRef.current
      if (!ed) return
      ed.revealLineInCenter(detail.line)
      ed.setPosition({ lineNumber: detail.line, column: detail.column })
      ed.focus()
    }
    window.addEventListener(PROJECT_EDITOR_GOTO_EVENT, handler as EventListener)
    return () => window.removeEventListener(PROJECT_EDITOR_GOTO_EVENT, handler as EventListener)
  }, [file.relPath])

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
      language: file.language,
      initialContent: file.draftContent,
    })
    handleRef.current = handle
    onDiagnosticsReadyRef.current?.(relPath, diagnostics)
    return () => {
      handle.dispose()
      handleRef.current = null
      onDiagnosticsReadyRef.current?.(relPath, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diag, file.relPath, file.absolutePath, file.language, projectRoot])

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
    })
    const nextDiagnostics = {
      monaco: monaco as unknown as MonacoLike,
      editor: editor as unknown as EditorLike,
    }
    setDiag(nextDiagnostics)
    if (resolvedTheme) {
      const variant: "light" | "dark" = resolvedTheme === "dark" ? "dark" : "light"
      const resolved = resolveActiveThemeColors({
        colorTheme: appearanceColorTheme,
        resolvedTheme: variant,
        activeCustomThemeId: appearanceActiveCustomThemeId,
        customThemes: appearanceCustomThemes,
      })
      syncCogniaActiveTheme(
        monaco as unknown as Parameters<typeof syncCogniaActiveTheme>[0],
        resolved.colors,
        variant
      )
      // @monaco-editor/react applies the `theme` prop before `onMount`. On the
      // first project-editor mount our custom theme is not registered yet, so
      // Monaco falls back to `vs`; defining the theme afterward does not select
      // it. Activate it explicitly so canvas-transparent tokens (notably the
      // minimap and overview ruler backgrounds) take effect immediately.
      monaco.editor.setTheme(COGNIA_ACTIVE_THEME_ID)
    }

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
          language={file.language}
          theme={COGNIA_ACTIVE_THEME_ID}
          options={{
            minimap: { enabled: true },
            fontSize: 13,
            scrollBeyondLastLine: false,
            renderWhitespace: "selection",
            automaticLayout: true,
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
