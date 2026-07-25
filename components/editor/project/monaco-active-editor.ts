/**
 * Assemble the engine-agnostic {@link ActiveEditorContext} from a live Monaco
 * instance — the Monaco half of the project editor's read side.
 *
 * code-server answers this read over its companion extension; Monaco has to be
 * asked directly. Both must produce the *same* shape, because everything
 * downstream (the `read_active_editor` agent tool, the plugin editor API, the
 * PII gate they share) is written to be engine-blind.
 *
 * Typed against minimal structural interfaces rather than the monaco-editor
 * types — the same convention as `hooks/use-monaco-markers.ts`, and what keeps
 * this unit-testable with plain fakes, since jsdom cannot run a real Monaco.
 */

import type { ActiveEditorContext, ActiveEditorDiagnostic } from "@/lib/files/project-editor-bridge"
import type { MonacoLike, RawMarker } from "@/hooks/use-monaco-markers"

/** Monaco's 1-based selection range. */
export interface MonacoSelectionLike {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface MonacoModelLike {
  uri: unknown
  getValueInRange(range: MonacoSelectionLike): string
}

/** The slice of a live Monaco editor a read needs. */
export interface ReadableMonacoEditor {
  getSelection(): MonacoSelectionLike | null
  getModel(): MonacoModelLike | null
}

/** Monaco's numeric MarkerSeverity: Hint=1, Info=2, Warning=4, Error=8. */
function severityOf(severity: number): ActiveEditorDiagnostic["severity"] {
  if (severity >= 8) return "error"
  if (severity >= 4) return "warning"
  if (severity >= 2) return "info"
  return "hint"
}

/** True when the range covers no characters, i.e. a bare caret. */
function isEmptySelection(selection: MonacoSelectionLike): boolean {
  return (
    selection.startLineNumber === selection.endLineNumber &&
    selection.startColumn === selection.endColumn
  )
}

export interface MonacoActiveEditorInput {
  /** Absolute path of the focused file, or null when nothing is open. */
  path: string | null
  /** Absolute paths of every open editor tab. */
  openEditors: string[]
  /** The live editor, or null before Monaco has mounted. */
  editor: ReadableMonacoEditor | null
  /** The Monaco namespace, or null before it has mounted. */
  monaco: MonacoLike | null
}

/**
 * Read `input` into the canonical snapshot. Never throws: a Monaco that has not
 * finished mounting simply yields the same "nothing focused" shape code-server
 * produces when no editor is open, so callers need no engine-specific branch.
 */
export function readMonacoActiveEditor(input: MonacoActiveEditorInput): ActiveEditorContext {
  const { path, openEditors, editor, monaco } = input
  const model = editor?.getModel() ?? null
  const selection = editor?.getSelection() ?? null

  // An empty selection is a caret, not a selection — code-server reports
  // `selectedText: null` there, so Monaco must not report "".
  const selectedText =
    model && selection && !isEmptySelection(selection) ? model.getValueInRange(selection) : null

  // Markers are filtered to the focused model's own resource; without the
  // filter Monaco hands back every open model's diagnostics, which would
  // attribute another file's errors to the file the user is looking at.
  const markers: RawMarker[] =
    monaco && model ? monaco.editor.getModelMarkers({ resource: model.uri }) : []

  return {
    path,
    selection: selection
      ? {
          startLine: selection.startLineNumber,
          startColumn: selection.startColumn,
          endLine: selection.endLineNumber,
          endColumn: selection.endColumn,
        }
      : null,
    selectedText,
    diagnostics: markers.map((marker) => ({
      message: marker.message,
      severity: severityOf(marker.severity),
      line: marker.startLineNumber,
      column: marker.startColumn,
    })),
    openEditors,
  }
}
