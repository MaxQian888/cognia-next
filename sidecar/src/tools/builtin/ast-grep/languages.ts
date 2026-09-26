// Languages the bundled `ast-grep` CLI understands. Ported verbatim from
// oh-my-opencode-slim's `src/tools/ast-grep/types.ts` (25 languages). Kept in
// its own module so both the tool schema (an enum) and the empty-result hints
// share one source of truth.

export const CLI_LANGUAGES: readonly string[] = Object.freeze([
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "elixir",
  "go",
  "haskell",
  "html",
  "java",
  "javascript",
  "json",
  "kotlin",
  "lua",
  "nix",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "solidity",
  "swift",
  "typescript",
  "tsx",
  "yaml",
])

export function isSupportedLanguage(lang: unknown): lang is string {
  return typeof lang === "string" && CLI_LANGUAGES.includes(lang)
}
