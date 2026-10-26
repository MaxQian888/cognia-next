/**
 * The plugin contract's share of `lib/files/project-editor-bridge.ts`, which re-exports these.
 */
/** One diagnostic in an {@link ActiveEditorContext} snapshot. */
export interface ActiveEditorDiagnostic {
  message: string
  severity: "error" | "warning" | "info" | "hint"
  /** 1-based line/column of the diagnostic's start. */
  line: number
  column: number
}

/**
 * Live active-editor context: "what is the user looking at". Whole file bodies
 * are deliberately excluded — callers read files with their own tools.
 *
 * This is the single canonical shape both engines produce. It originated as
 * code-server's wire payload; Monaco assembles the same fields from its model,
 * selection and markers. Keeping one shape is what lets the PII gate and the
 * tool contract downstream stay engine-blind — if the two ever diverge, every
 * consumer has to learn which engine it is talking to.
 */
export interface ActiveEditorContext {
  /** Absolute path of the focused file editor, or null when none is focused. */
  path: string | null
  /** 1-based selection range, or null when nothing is focused. */
  selection: { startLine: number; startColumn: number; endLine: number; endColumn: number } | null
  /** The selected text, or null for an empty selection / no editor. */
  selectedText: string | null
  diagnostics: ActiveEditorDiagnostic[]
  /** Absolute paths of the open file editors. */
  openEditors: string[]
}
