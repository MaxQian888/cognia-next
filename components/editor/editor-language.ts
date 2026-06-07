/**
 * Shared editor language ids + path mapping.
 *
 * Promoted from `components/skills/editor/language-from-path.ts` so every
 * editing surface (Skills, Canvas, Artifacts) and both editor stacks (Monaco
 * on desktop, the CodeMirror `LightCodeEditor` on mobile) share one closed
 * union. The values stay Monaco language ids — the CM loader
 * (`load-language-support.ts`) maps them to lazily-imported grammars.
 */

export type EditorLanguage = "markdown" | "typescript" | "python" | "shell" | "json" | "plaintext"

const TABLE: Record<string, EditorLanguage> = {
  md: "markdown",
  markdown: "markdown",
  js: "typescript",
  ts: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  jsx: "typescript",
  tsx: "typescript",
  py: "python",
  pyi: "python",
  sh: "shell",
  bash: "shell",
  json: "json",
  jsonc: "json",
}

export function languageFromPath(path: string): EditorLanguage {
  const dot = path.lastIndexOf(".")
  if (dot === -1) return "plaintext"
  const ext = path.slice(dot + 1).toLowerCase()
  return TABLE[ext] ?? "plaintext"
}

/**
 * Map a (possibly broader) Monaco language id — as stored on Canvas /
 * Artifact documents — onto the light editor's closed union. Unknown ids
 * degrade to plaintext (no highlighting, everything else still works).
 */
const MONACO_ID_MAP: Record<string, EditorLanguage> = {
  markdown: "markdown",
  typescript: "typescript",
  javascript: "typescript",
  typescriptreact: "typescript",
  javascriptreact: "typescript",
  python: "python",
  shell: "shell",
  shellscript: "shell",
  bash: "shell",
  json: "json",
  jsonc: "json",
}

export function editorLanguageFromMonacoId(id: string | undefined | null): EditorLanguage {
  if (!id) return "plaintext"
  return MONACO_ID_MAP[id.toLowerCase()] ?? "plaintext"
}
