/**
 * Adapts the in-browser diagnostics producers to a CodeMirror 6 lint extension,
 * with a reserved seam for external (LSP) diagnostics.
 *
 * `editorDiagnostics({ language })` returns `[externalField, linter, lintGutter]`.
 * The linter source merges the language's in-browser producer output with any
 * diagnostics pushed through `pushDiagnostics` / `setExternalDiagnostics`
 * (empty in v1 — this is where a future desktop/companion LSP feed plugs in).
 */

import { StateField, StateEffect, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import {
  linter,
  lintGutter,
  forceLinting,
  forEachDiagnostic,
  type Diagnostic,
} from "@codemirror/lint"
import type { EditorLanguage } from "../editor-language"
import { getDiagnosticsProducer } from "./registry"
import type { DiagnosticSummary, EditorDiagnostic } from "./types"

/** Default debounce before the linter runs after an edit (ms). */
export const DEFAULT_LINT_DELAY = 400

/** Push external (e.g. LSP) diagnostics into the editor — the hybrid seam. */
export const setExternalDiagnostics = StateEffect.define<readonly EditorDiagnostic[]>()

/** Holds the most recent externally-pushed diagnostics. */
export const externalDiagnosticsField = StateField.define<readonly EditorDiagnostic[]>({
  create: () => [],
  update(value, tr) {
    let next = value
    for (const effect of tr.effects) {
      if (effect.is(setExternalDiagnostics)) next = effect.value
    }
    return next
  },
})

/** Clamp an `EditorDiagnostic` to the document and convert to a CM `Diagnostic`. */
export function toCmDiagnostic(d: EditorDiagnostic, docLength: number): Diagnostic {
  const from = clamp(d.from, docLength)
  const to = Math.max(from, clamp(d.to, docLength))
  return { from, to, severity: d.severity, message: d.message, source: d.source }
}

/**
 * Produce the merged diagnostic set for a document — the pure core of the
 * linter source, unit-testable without an `EditorView`.
 */
export async function runDiagnostics(
  language: EditorLanguage,
  text: string,
  external: readonly EditorDiagnostic[]
): Promise<Diagnostic[]> {
  const producer = getDiagnosticsProducer(language)
  let own: EditorDiagnostic[] = []
  if (producer) {
    try {
      own = await producer(text)
    } catch {
      own = [] // a producer must never break editing
    }
  }
  return [...own, ...external].map((d) => toCmDiagnostic(d, text.length))
}

export interface EditorDiagnosticsOptions {
  language: EditorLanguage
  /** Override the debounce (ms). */
  delay?: number
}

/** The CM lint source for a language — reads the doc + external field and merges. */
export function buildLintSource(language: EditorLanguage) {
  return (view: Pick<EditorView, "state">): Promise<Diagnostic[]> =>
    runDiagnostics(
      language,
      view.state.doc.toString(),
      view.state.field(externalDiagnosticsField, false) ?? []
    )
}

export function editorDiagnostics({
  language,
  delay = DEFAULT_LINT_DELAY,
}: EditorDiagnosticsOptions): Extension {
  return [externalDiagnosticsField, linter(buildLintSource(language), { delay }), lintGutter()]
}

/** Imperatively replace the external diagnostics and re-run linting now. */
export function pushDiagnostics(view: EditorView, diagnostics: readonly EditorDiagnostic[]): void {
  view.dispatch({ effects: setExternalDiagnostics.of(diagnostics) })
  forceLinting(view)
}

/** Count diagnostics by severity for the status bar. */
export function getDiagnosticSummary(
  state: Parameters<typeof forEachDiagnostic>[0]
): DiagnosticSummary {
  let errors = 0
  let warnings = 0
  let infos = 0
  forEachDiagnostic(state, (d) => {
    if (d.severity === "error") errors++
    else if (d.severity === "warning") warnings++
    else infos++
  })
  return { errors, warnings, infos }
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  if (value > max) return max
  return value
}
