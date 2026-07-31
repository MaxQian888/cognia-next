/**
 * Canvas document languages — the selectable language set and the mapping from
 * a language to the `CanvasDocument.type` ("text" enables the Markdown format
 * toolbar; everything else is "code"). Shared by the toolbar language selector
 * and the create-with-type menu so the two never drift.
 *
 * Labels are language proper nouns (JavaScript, Mermaid, …) — not localized,
 * matching the existing `TRANSLATE_LANGUAGES` convention in `constants.ts`.
 */

import type { ArtifactLanguage } from "@/types/artifact/artifact"

/** Languages authored as prose (Markdown format toolbar, `type: "text"`). */
export const CANVAS_TEXT_LANGUAGES: ReadonlySet<ArtifactLanguage> = new Set<ArtifactLanguage>([
  "markdown",
  "plaintext",
])

/** Derive a `CanvasDocument.type` from its language. */
export function canvasTypeForLanguage(language: ArtifactLanguage): "code" | "text" {
  return CANVAS_TEXT_LANGUAGES.has(language) ? "text" : "code"
}

export interface CanvasLanguageOption {
  value: ArtifactLanguage
  label: string
}

/** Ordered language options for the selector / create menu (text first). */
export const CANVAS_LANGUAGE_OPTIONS: readonly CanvasLanguageOption[] = [
  { value: "markdown", label: "Markdown" },
  { value: "plaintext", label: "Plain Text" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "jsx", label: "JSX" },
  { value: "tsx", label: "TSX" },
  { value: "python", label: "Python" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "sql", label: "SQL" },
  { value: "bash", label: "Bash" },
  { value: "xml", label: "XML" },
  { value: "svg", label: "SVG" },
  { value: "mermaid", label: "Mermaid" },
  { value: "latex", label: "LaTeX" },
]

/** Human label for a language value (falls back to the raw value). */
export function canvasLanguageLabel(language: ArtifactLanguage): string {
  return CANVAS_LANGUAGE_OPTIONS.find((o) => o.value === language)?.label ?? language
}
