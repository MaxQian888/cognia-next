// Languages the bundled `ast-grep` CLI understands. Ported verbatim from
// oh-my-opencode-slim's `src/tools/ast-grep/types.ts` (25 languages). Kept in
// its own module so both the tool schema (an enum) and the empty-result hints
// share one source of truth.

/** @type {readonly string[]} */
export const CLI_LANGUAGES = Object.freeze([
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

/** @param {unknown} lang @returns {boolean} */
export function isSupportedLanguage(lang) {
  return typeof lang === "string" && CLI_LANGUAGES.includes(lang)
}
