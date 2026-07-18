"use client"

// Monaco mount for the project editor (`file` surface). Unlike the Skills /
// Canvas editors this addresses the document by its REAL `file://` URI so the
// LSP resolves it against the actual project root (cross-file navigation,
// project diagnostics). Reuses the shared workbench primitive, the shared
// surface-aware action registry, snippets, and Emmet.

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
  mountMonacoWorkbench,
  type IMonacoEditor,
  type MonacoNamespace,
  type MonacoWorkbenchHandle,
} from "@/lib/editor-workbench/monaco-workbench"
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
  const [diag, setDiag] = useState<{ monaco: MonacoLike; editor: EditorLike } | null>(null)

  const appearanceColorTheme = useSettingsStore((s) => s.colorTheme)
  const appearanceActiveCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const appearanceCustomThemes = useSettingsStore((s) => s.customThemes)

  useEffect(() => {
    configureMonacoLoader()
  }, [])

  useEffect(() => {
    return () => {
      handleRef.current?.dispose()
      handleRef.current = null
      actionDisposablesRef.current.forEach((d) => d.dispose())
      actionDisposablesRef.current = []
      onDiagnosticsReady?.(file.relPath, null)
    }
  }, [file.absolutePath, file.relPath, onDiagnosticsReady])

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

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor as unknown as RevealableEditor
    const revealableEditor = editor as unknown as RevealableEditor
    revealableEditor.onDidChangeCursorSelection((event) => {
      const model = revealableEditor.getModel()
      if (!model) return
      const start = model.getOffsetAt(event.selection.getStartPosition())
      const end = model.getOffsetAt(event.selection.getEndPosition())
      onSelectionChange?.(start === end ? undefined : { kind: "text", start, end })
    })
    const nextDiagnostics = {
      monaco: monaco as unknown as MonacoLike,
      editor: editor as unknown as EditorLike,
    }
    setDiag(nextDiagnostics)
    onDiagnosticsReady?.(file.relPath, nextDiagnostics)
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
    }

    handleRef.current = mountMonacoWorkbench(
      editor as unknown as IMonacoEditor,
      monaco as unknown as MonacoNamespace,
      {
        surface: "file",
        documentId: file.relPath,
        absolutePath: file.absolutePath,
        projectRoot,
        language: file.language,
        initialContent: file.draftContent,
      }
    )

    // Snippets / Emmet are global-per-instance (idempotent); actions are per
    // editor so they attach here and tear down on unmount.
    registerAllSnippets(monaco)
    registerEmmetSupport(monaco)
    actionDisposablesRef.current = registerEditorActions(editor, monaco, {
      idPrefix: "file.kb.",
      triggerSource: "project-editor",
      bindings,
      labels: actionLabels,
      actions,
      includePluginCommands: true,
    })
  }

  return (
    <div className="flex h-full flex-col">
      <LspServerHint language={file.language} />
      <div className="min-h-0 flex-1">
        <Editor
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
