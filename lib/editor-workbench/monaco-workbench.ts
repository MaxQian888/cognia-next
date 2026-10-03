/**
 * Monaco workbench primitive — the load-bearing wire between any Monaco
 * surface (Canvas / Skills / Artifact / future) and the VS Code reuse
 * layer at `lib/plugin/vscode-shim/monaco-bridge`.
 *
 * Why this exists:
 *   - Real LSP support requires every Monaco editor in cognia-next to
 *     register itself with the bridge so VS Code extensions can see it
 *     as `vscode.window.activeTextEditor` and bind providers (completion,
 *     hover, diagnostics, code actions, formatting, go-to-def, …) to
 *     stable document URIs.
 *   - The bridge exposes raw notify* functions; this primitive packages
 *     the URI construction, model lifecycle, focus/content/selection
 *     listener wiring, and dispose into one call site.
 *   - The existing `bindMonacoEditorContext` (snippets / outline registry)
 *     keeps working in parallel — this primitive calls it too.
 *
 * URI scheme convention:
 *   - canvas:///{sessionId}/{documentId}.{ext}
 *   - skill:///{skillId}/{file or documentId}.{ext}
 *   - artifact:///{documentId}.{ext}
 *   - file → the document's real `file://{absolutePath}` URI (project editor)
 *   - any other surface → {surface}:///{documentId}.{ext}
 *
 * The `file` surface is special: its models are backed by real on-disk files
 * (project editor rooted at a team `workingDir`/worktree), so it addresses
 * them with genuine `file://` URIs. This lets the LSP `workspaceFolder` point
 * at the actual project root and makes cross-file navigation / project-wide
 * diagnostics resolve against real paths — unlike the synthetic per-document
 * schemes used by canvas/skill/artifact.
 */

import { bindMonacoEditorContext } from "./monaco-context-binding"
import type { MonacoContextBinding } from "./monaco-context-binding"
import {
  notifyEditorMounted,
  notifyEditorUnmounted,
  notifyActiveEditorChanged,
  notifyContentChanged,
  notifySelectionChanged,
  type MonacoEditor as BridgeMonacoEditor,
  type MonacoTextModel as BridgeMonacoTextModel,
} from "@/lib/plugin/vscode-shim/monaco-bridge"
import { getFileExtension } from "@/lib/canvas/utils"
import { pathToFileUri } from "@/lib/files/path-uri"
import { registerAllSnippets, registerEmmetSupport } from "@/lib/monaco/snippets"
import {
  disposeWorkspace,
  ensureWorkspace,
  isLspWorkspaceManagerConfigured,
  registerProjectWorkspace,
} from "@/lib/plugin/vscode-shim/lsp-workspace-manager"

// ────────────────────────────────────────────────────────────────────────
// Minimal real-monaco interface shapes (decoupled from monaco-editor pkg).
// ────────────────────────────────────────────────────────────────────────

export interface IDisposable {
  dispose(): void
}

export interface IMonacoUri {
  toString(): string
  scheme?: string
  path?: string
}

export interface IMonacoModel {
  uri: IMonacoUri
  getLanguageId(): string
  getValue(): string
  setValue(value: string): void
  getLineCount(): number
  getLineContent(line: number): string
  isDisposed(): boolean
  getVersionId?(): number
  getOptions?(): { tabSize: number; insertSpaces: boolean }
  updateOptions?(options: { tabSize?: number; insertSpaces?: boolean }): void
  /** Monaco `EndOfLineSequence`: 0 LF, 1 CRLF. */
  pushEOL?(eol: number): void
  onDidChangeContent(listener: () => void): IDisposable
}

export interface IMonacoPosition {
  lineNumber: number
  column: number
}

export interface IMonacoRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface IMonacoEditor {
  getId(): string
  getModel(): IMonacoModel | null
  setModel(model: IMonacoModel | null): void
  getPosition(): IMonacoPosition | null
  getSelection(): IMonacoRange | null
  getSelections?(): Array<{
    selectionStartLineNumber: number
    selectionStartColumn: number
    positionLineNumber: number
    positionColumn: number
  }> | null
  onDidFocusEditorWidget(listener: () => void): IDisposable
  onDidBlurEditorWidget(listener: () => void): IDisposable
  onDidChangeCursorSelection(listener: () => void): IDisposable
  executeEdits(source: string | null, edits: unknown[]): boolean
  deltaDecorations(oldIds: string[], newDecorations: unknown[]): string[]
  pushUndoStop?(): boolean
  getContribution?(id: string): unknown
  revealRange?(range: IMonacoRange): void
  revealRangeInCenter?(range: IMonacoRange): void
  revealRangeInCenterIfOutsideViewport?(range: IMonacoRange): void
  revealRangeAtTop?(range: IMonacoRange): void
  setSelections?(
    selections: Array<{
      selectionStartLineNumber: number
      selectionStartColumn: number
      positionLineNumber: number
      positionColumn: number
    }>
  ): void
  updateOptions?(options: Record<string, unknown>): void
  getVisibleRanges?(): IMonacoRange[]
  onDidScrollChange?(listener: () => void): IDisposable
}

export interface MonacoNamespace {
  Uri: {
    parse(value: string): IMonacoUri
  }
  editor: {
    createModel(value: string, language: string, uri?: IMonacoUri): IMonacoModel
    getModel(uri: IMonacoUri): IMonacoModel | null
  }
}

// ────────────────────────────────────────────────────────────────────────
// Workbench API
// ────────────────────────────────────────────────────────────────────────

export type WorkbenchSurface = "canvas" | "skill" | "artifact" | "file" | (string & {})

export interface MonacoWorkbenchSpec {
  /** Surface identifier — keys the URI scheme. */
  surface: WorkbenchSurface
  /** Stable id of the open document on the surface. */
  documentId: string
  /** Canvas session id, embedded in the canvas:/// URI path. */
  sessionId?: string
  /** Skill id, embedded in the skill:/// URI path. */
  skillId?: string
  /** Optional path segments for skill / artifact / future surfaces. */
  pathSegments?: string[]
  /**
   * Absolute on-disk path of the document. REQUIRED for the `file` surface —
   * it becomes the `file://` model URI so the LSP resolves it against the real
   * project. Ignored by the synthetic surfaces.
   */
  absolutePath?: string
  /**
   * Absolute path of the project root this document belongs to (`file`
   * surface only). Threaded to the LSP workspace manager so the
   * `workspaceFolder` points at the real project directory.
   */
  projectRoot?: string
  /** Monaco language id (e.g. "typescript", "python"). */
  language: string
  /** Content used only when no existing model is found at the URI. */
  initialContent: string
}

export interface MonacoWorkbenchHandle {
  /** Stable URI the bridge / VS Code extensions see for this document. */
  uri: string
  /** Tear down listeners, unregister with the bridge. */
  dispose(): void
}

/**
 * Build the stable URI for a workbench document. Scheme is `surface`.
 * Path encodes the identity an extension needs to address the document.
 */
export function buildWorkbenchUri(spec: MonacoWorkbenchSpec): string {
  const ext = getFileExtension(spec.language)
  switch (spec.surface) {
    case "canvas": {
      const session = spec.sessionId ?? "default"
      return `canvas:///${session}/${spec.documentId}.${ext}`
    }
    case "skill": {
      const skill = spec.skillId ?? spec.documentId
      const file =
        spec.pathSegments && spec.pathSegments.length > 0
          ? spec.pathSegments.join("/")
          : `${spec.documentId}.${ext}`
      return `skill:///${skill}/${file}`
    }
    case "artifact": {
      return `artifact:///${spec.documentId}.${ext}`
    }
    case "file": {
      if (!spec.absolutePath) {
        throw new Error(
          "monaco-workbench: the `file` surface requires spec.absolutePath (the document's real on-disk path)"
        )
      }
      return pathToFileUri(spec.absolutePath)
    }
    default: {
      return `${spec.surface}:///${spec.documentId}.${ext}`
    }
  }
}

/**
 * Adapter from a real monaco editor (@monaco-editor/react onMount instance)
 * to the bridge's minimal `MonacoEditor` shape. The bridge uses this to
 * track active-editor identity and read selection / model state without
 * pulling the full `monaco-editor` package into its dependency graph.
 */
function adaptEditorForBridge(editor: IMonacoEditor): BridgeMonacoEditor {
  /** Decoration ids per decoration type, so a type's next set replaces its last. */
  const decorationIds = new Map<string, string[]>()
  return {
    id: editor.getId(),
    getModel: () => {
      const m = editor.getModel()
      if (!m) return null
      const adapted: BridgeMonacoTextModel = {
        uri: m.uri.toString(),
        language: m.getLanguageId(),
        getValue: () => m.getValue(),
        setValue: (v) => m.setValue(v),
        getLineCount: () => m.getLineCount(),
        getLineContent: (line: number) => m.getLineContent(line),
        isDisposed: () => m.isDisposed(),
        ...(m.getVersionId ? { getVersionId: () => m.getVersionId!() } : {}),
      }
      return adapted
    },
    getPosition: () => editor.getPosition(),
    getSelections: () =>
      (editor.getSelections?.() ?? []).map((s) => ({
        anchor: { lineNumber: s.selectionStartLineNumber, column: s.selectionStartColumn },
        active: { lineNumber: s.positionLineNumber, column: s.positionColumn },
      })),
    getSelection: () => {
      const s = editor.getSelection()
      if (!s) return null
      return {
        startLineNumber: s.startLineNumber,
        startColumn: s.startColumn,
        endLineNumber: s.endLineNumber,
        endColumn: s.endColumn,
      }
    },
    applyEdits: (edits) => {
      editor.executeEdits("workbench", edits as unknown[])
    },
    setDecorations: (typeId, decorations) => {
      // Each type's decorations replace that type's previous ones.
      const previous = decorationIds.get(typeId) ?? []
      const next = editor.deltaDecorations(previous, decorations as unknown[])
      if (next.length > 0) decorationIds.set(typeId, next)
      else decorationIds.delete(typeId)
    },
    pushUndoStop: () => {
      editor.pushUndoStop?.()
    },
    insertSnippet: (snippet, ranges) => {
      editor.setSelections?.(
        ranges.map((range) => ({
          selectionStartLineNumber: range.startLineNumber,
          selectionStartColumn: range.startColumn,
          positionLineNumber: range.endLineNumber,
          positionColumn: range.endColumn,
        }))
      )
      const controller = editor.getContribution?.("snippetController2") as
        { insert(template: string): void } | null | undefined
      if (controller) controller.insert(snippet)
      else
        editor.executeEdits(
          "workbench",
          ranges.map((range) => ({ range, text: snippet }))
        )
    },
    revealRange: (range, revealType) => {
      // VS Code's TextEditorRevealType: Default 0, InCenter 1, InCenterIfOutsideViewport 2, AtTop 3.
      if (revealType === 1) editor.revealRangeInCenter?.(range)
      else if (revealType === 2) editor.revealRangeInCenterIfOutsideViewport?.(range)
      else if (revealType === 3) editor.revealRangeAtTop?.(range)
      else editor.revealRange?.(range)
    },
    setSelections: (selections) => {
      editor.setSelections?.(
        selections.map((selection) => ({
          selectionStartLineNumber: selection.anchor.lineNumber,
          selectionStartColumn: selection.anchor.column,
          positionLineNumber: selection.active.lineNumber,
          positionColumn: selection.active.column,
        }))
      )
    },
    updateOptions: (options) => {
      const model = editor.getModel()
      const modelOptions = {
        ...(options.tabSize !== undefined ? { tabSize: options.tabSize } : {}),
        ...(options.insertSpaces !== undefined ? { insertSpaces: options.insertSpaces } : {}),
      }
      if (Object.keys(modelOptions).length > 0) model?.updateOptions?.(modelOptions)
      // VS Code's TextEditorCursorStyle starts at 1 (Line); Monaco names the same styles.
      const cursorStyles = [
        "line",
        "block",
        "underline",
        "line-thin",
        "block-outline",
        "underline-thin",
      ]
      const editorOptions = {
        ...(options.cursorStyle !== undefined
          ? { cursorStyle: cursorStyles[options.cursorStyle - 1] ?? "line" }
          : {}),
        // VS Code's TextEditorLineNumbersStyle: Off 0, On 1, Relative 2, Interval 3.
        ...(options.lineNumbers !== undefined
          ? { lineNumbers: ["off", "on", "relative", "interval"][options.lineNumbers] ?? "on" }
          : {}),
      }
      if (Object.keys(editorOptions).length > 0) editor.updateOptions?.(editorOptions)
    },
    getVisibleRanges: () => editor.getVisibleRanges?.() ?? [],
    getOptions: () => {
      const options = editor.getModel()?.getOptions?.()
      return { tabSize: options?.tabSize ?? 4, insertSpaces: options?.insertSpaces ?? true }
    },
    setEndOfLine: (eol) => {
      editor.getModel()?.pushEOL?.(eol === 2 ? 1 : 0)
    },
  }
}

/**
 * Mount a Monaco editor into the workbench.
 *
 * Side effects:
 *   1. Ensures the editor's model has the URI dictated by `spec`,
 *      creating a fresh model with `initialContent` if no model exists
 *      at the URI yet, or reusing the cached one if it does.
 *   2. Binds the editor to the snippets/outline registry via
 *      `bindMonacoEditorContext` (preserves existing behavior).
 *   3. Registers global snippet and Emmet completion providers for the
 *      Monaco namespace (idempotent per Monaco instance).
 *   4. Notifies the vscode-shim bridge so LSP providers can address
 *      this editor as `vscode.window.activeTextEditor` and bind
 *      providers to its URI.
 *   5. Wires focus / blur / content / selection listeners and forwards
 *      them to the bridge.
 *
 * The returned `dispose()` tears down 2 + 3 + 4. It deliberately does
 * NOT dispose the model — Monaco models can be reused across remounts
 * (e.g., tab switches), and the parent component owns the model
 * lifecycle.
 */
export function mountMonacoWorkbench(
  editor: IMonacoEditor,
  monaco: MonacoNamespace,
  spec: MonacoWorkbenchSpec
): MonacoWorkbenchHandle {
  const uriString = buildWorkbenchUri(spec)
  const uri = monaco.Uri.parse(uriString)

  // Reuse the model if one already exists at the URI (preserves undo
  // history across remounts). Otherwise create a fresh one with the
  // provided initial content.
  let model: IMonacoModel | null = monaco.editor.getModel(uri)
  if (!model) {
    model = monaco.editor.createModel(spec.initialContent, spec.language, uri)
  }
  if (editor.getModel() !== model) {
    editor.setModel(model)
  }

  // Completion registration belongs at the shared workbench seam so Skills,
  // Artifacts, Canvas, and project files behave identically even when a less
  // common surface is the first Monaco editor mounted in the app.
  registerAllSnippets(monaco)
  registerEmmetSupport(monaco)

  // Step 2 — light registry binding. Threads the surface discriminator + live
  // editor + selection/cursor so the plugin Canvas API (`canvas-api.ts`) can
  // read the real editor instead of only the store snapshot.
  const readCursor = () => {
    const p = editor.getPosition()
    return p ? { line: p.lineNumber, column: p.column } : undefined
  }
  const lightBinding: MonacoContextBinding = bindMonacoEditorContext({
    editorId: editor.getId(),
    contextId: spec.surface,
    editor,
    documentId: spec.documentId,
    language: spec.language,
    getValue: () => editor.getModel()?.getValue() ?? "",
    selection: editor.getSelection(),
    cursor: readCursor(),
  })

  // Step 3 — materialise synthetic documents before exposing them to the
  // standalone LSP bridge. VS Code-extension providers remain on the same
  // Monaco model and therefore share the stable URI.
  const bridgeEditor = adaptEditorForBridge(editor)
  let bridgeMounted = false
  let disposed = false
  const notifyMounted = () => {
    if (disposed || bridgeMounted) return
    bridgeMounted = true
    notifyEditorMounted(bridgeEditor)
  }
  if (spec.surface === "file") {
    if (spec.projectRoot) registerProjectWorkspace(spec.projectRoot)
    notifyMounted()
  } else if (isLspWorkspaceManagerConfigured()) {
    const fileName =
      spec.pathSegments && spec.pathSegments.length > 0
        ? spec.pathSegments.join("/")
        : (uriString.split("/").pop() ?? `${spec.documentId}.${getFileExtension(spec.language)}`)
    const workspaceId =
      spec.surface === "skill" ? (spec.skillId ?? spec.documentId) : spec.documentId
    void ensureWorkspace({
      surface: spec.surface,
      documentId: workspaceId,
      fileName,
      initialContent: model.getValue(),
      monacoUri: uriString,
    }).then(notifyMounted, notifyMounted)
  } else {
    notifyMounted()
  }

  // Step 4 — focus / content / selection listener wiring.
  const focusDisposable = editor.onDidFocusEditorWidget(() => {
    notifyActiveEditorChanged(editor.getId())
  })
  const blurDisposable = editor.onDidBlurEditorWidget(() => {
    notifyActiveEditorChanged(null)
  })
  const contentDisposable = model.onDidChangeContent(() => {
    notifyContentChanged(editor.getId())
  })
  // Scrolling changes the editor's visible ranges, which extensions can watch.
  const scrollDisposable = editor.onDidScrollChange?.(() => {
    notifySelectionChanged(editor.getId())
  })
  const selectionDisposable = editor.onDidChangeCursorSelection(() => {
    notifySelectionChanged(editor.getId())
    lightBinding.update({ selection: editor.getSelection(), cursor: readCursor() })
  })

  return {
    uri: uriString,
    dispose: () => {
      if (disposed) return
      disposed = true
      focusDisposable.dispose()
      blurDisposable.dispose()
      contentDisposable.dispose()
      selectionDisposable.dispose()
      scrollDisposable?.dispose()
      if (bridgeMounted) notifyEditorUnmounted(editor.getId())
      if (
        spec.surface !== "file" &&
        spec.surface !== "skill" &&
        isLspWorkspaceManagerConfigured()
      ) {
        void disposeWorkspace({ surface: spec.surface, documentId: spec.documentId })
      }
      lightBinding.dispose()
    },
  }
}
