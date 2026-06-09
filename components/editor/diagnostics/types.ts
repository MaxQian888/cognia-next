/**
 * Editor-agnostic diagnostic shape for the CM6 light editor's in-browser
 * checking layer. Decoupled from `@codemirror/lint`'s `Diagnostic` so the
 * producer functions (`lint-json`, `lint-babel`, …) stay pure and unit-testable
 * without importing CodeMirror. `cm-linter.ts` adapts these to CM `Diagnostic`s.
 */

export type DiagnosticSeverity = "error" | "warning" | "info"

export interface EditorDiagnostic {
  /** Inclusive start offset into the document. */
  from: number
  /** Exclusive end offset (≥ `from`). */
  to: number
  severity: DiagnosticSeverity
  message: string
  /** Origin label (e.g. "json", "babel", "lsp"); shown in the lint tooltip. */
  source?: string
}

/** Aggregate counts surfaced to the status bar / `onDiagnosticsChange`. */
export interface DiagnosticSummary {
  errors: number
  warnings: number
  infos: number
}

/**
 * A producer turns document text into diagnostics. May be sync (native JSON) or
 * async (lazy-loaded parsers). Returning `[]` means "checked, no problems".
 */
export type DiagnosticsProducer = (text: string) => EditorDiagnostic[] | Promise<EditorDiagnostic[]>
