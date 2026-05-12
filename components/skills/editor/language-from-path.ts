export type MonacoLanguage = "markdown" | "typescript" | "python" | "shell" | "json" | "plaintext"

const TABLE: Record<string, MonacoLanguage> = {
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

export function languageFromPath(path: string): MonacoLanguage {
  const dot = path.lastIndexOf(".")
  if (dot === -1) return "plaintext"
  const ext = path.slice(dot + 1).toLowerCase()
  return TABLE[ext] ?? "plaintext"
}
