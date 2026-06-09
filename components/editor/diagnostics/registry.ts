/**
 * Maps an `EditorLanguage` to its in-browser diagnostics producer. Languages
 * without a real parser return `null` — we intentionally emit nothing rather
 * than guess, so the editor never shows false positives for python / shell /
 * markdown / plaintext.
 */

import type { EditorLanguage } from "../editor-language"
import { lintJson } from "./lint-json"
import { lintBabel } from "./lint-babel"
import type { DiagnosticsProducer } from "./types"

export function getDiagnosticsProducer(language: EditorLanguage): DiagnosticsProducer | null {
  switch (language) {
    case "json":
      return lintJson
    case "typescript":
      return lintBabel
    default:
      return null
  }
}
