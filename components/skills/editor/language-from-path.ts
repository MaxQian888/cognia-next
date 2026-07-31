/**
 * Back-compat re-export — the table moved to the shared
 * `components/editor/editor-language.ts` so the CodeMirror light editor and
 * the Monaco surfaces use one language union. `MonacoLanguage` remains the
 * historical alias used across the skills editor.
 */

export { languageFromPath } from "@/components/editor/editor-language"
export type { EditorLanguage as MonacoLanguage } from "@/components/editor/editor-language"
