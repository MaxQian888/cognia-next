/**
 * Map a file path to a Monaco language id for the diff editor. Kept tiny and
 * pure; the Canvas surface stores its language directly rather than deriving it
 * from an extension, so there is no existing map to reuse.
 */

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  mdx: "markdown",
  rs: "rust",
  go: "go",
  py: "python",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  dockerfile: "dockerfile",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "html",
}

const FILENAME_TO_LANGUAGE: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".gitignore": "ignore",
  ".gitattributes": "ignore",
}

/** Resolve a Monaco language id from a repo-relative path. */
export function languageFromPath(path: string): string {
  const base = path.split("/").pop()?.toLowerCase() ?? ""
  if (FILENAME_TO_LANGUAGE[base]) return FILENAME_TO_LANGUAGE[base]
  const dot = base.lastIndexOf(".")
  if (dot < 0) return "plaintext"
  const ext = base.slice(dot + 1)
  return EXT_TO_LANGUAGE[ext] ?? "plaintext"
}
