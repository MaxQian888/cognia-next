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
