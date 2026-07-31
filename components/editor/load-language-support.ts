/**
 * Lazy CodeMirror grammar loader for the `LightCodeEditor`.
 *
 * Each language pack is a separate dynamic `import()` so the mobile bundle
 * pays only for grammars it actually opens (the CM core is already shipped
 * via the workflow expression field). `plaintext` — and any unknown id —
 * resolves to `null` (no language extension).
 */

import type { Extension } from "@codemirror/state"
import type { EditorLanguage } from "./editor-language"

export async function loadLanguageSupport(language: EditorLanguage): Promise<Extension | null> {
  switch (language) {
    case "markdown": {
      const { markdown } = await import("@codemirror/lang-markdown")
      return markdown()
    }
    case "typescript": {
      const { javascript } = await import("@codemirror/lang-javascript")
      return javascript({ typescript: true, jsx: true })
    }
    case "python": {
      const { python } = await import("@codemirror/lang-python")
      return python()
    }
    case "json": {
      const { json } = await import("@codemirror/lang-json")
      return json()
    }
    case "shell": {
      const [{ StreamLanguage }, { shell }] = await Promise.all([
        import("@codemirror/language"),
        import("@codemirror/legacy-modes/mode/shell"),
      ])
      return StreamLanguage.define(shell)
    }
    default:
      return null
  }
}
