/**
 * Syntax highlighting for fenced code blocks via `cli-highlight` (highlight.js,
 * CJS). Returns an ANSI-colored string that Ink's `<Text>` renders verbatim;
 * the text content is preserved exactly (only color escapes are added), so the
 * line still measures and wraps correctly after stripping.
 *
 * The colours can follow the active theme: {@link paletteCodeTheme} turns a
 * {@link ThemePalette}'s `code*` tokens into a cli-highlight `Theme`. Under the
 * `classic` palette (plain ANSI names) it returns undefined so cli-highlight's
 * own default theme is used — byte-for-byte the historic output. A themed
 * palette (hex code tokens, e.g. from Codex reuse) produces a custom theme.
 */
import chalk from "chalk"
import { highlight, type Theme } from "cli-highlight"
import { supportsLanguage } from "cli-highlight"

import type { ThemePalette } from "../theme/palette"

const ANSI_RE = /\[[0-9;]*m/g

/** Remove ANSI color escapes — used for width measurement and test assertions. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

/** Named ANSI chalk styles, for palette values that are colour keywords. */
const NAMED: Record<string, (s: string) => string> = {
  black: chalk.black,
  red: chalk.red,
  green: chalk.green,
  yellow: chalk.yellow,
  blue: chalk.blue,
  magenta: chalk.magenta,
  cyan: chalk.cyan,
  white: chalk.white,
  gray: chalk.gray,
  grey: chalk.gray,
  redBright: chalk.redBright,
  greenBright: chalk.greenBright,
  yellowBright: chalk.yellowBright,
  blueBright: chalk.blueBright,
  magentaBright: chalk.magentaBright,
  cyanBright: chalk.cyanBright,
  whiteBright: chalk.whiteBright,
}

/** Turn a palette colour value (hex or ANSI keyword) into a chalk colour fn. */
function colorFn(value: string): (s: string) => string {
  if (value.startsWith("#")) return chalk.hex(value)
  return NAMED[value] ?? ((s: string) => s)
}

/** Extension (no dot) → highlight.js language id. Shared by the text viewer and
 * the edit-diff renderer so language inference lives in one place. Every value
 * here must be a language `cli-highlight` actually supports — guarded by an
 * invariant test so a typo/unsupported id can't silently degrade to no colour. */
export const LANG_BY_EXT: Record<string, string> = {
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
  json5: "json",
  rs: "rust",
  py: "python",
  pyi: "python",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  csx: "csharp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  psm1: "powershell",
  bat: "dos",
  cmd: "dos",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  properties: "properties",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  sql: "sql",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  dart: "dart",
  lua: "lua",
  r: "r",
  pl: "perl",
  pm: "perl",
  ex: "elixir",
  exs: "elixir",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  hs: "haskell",
  scala: "scala",
  sc: "scala",
  groovy: "groovy",
  gradle: "groovy",
  fs: "fsharp",
  fsx: "fsharp",
  vb: "vbnet",
  jl: "julia",
  erl: "erlang",
  hrl: "erlang",
  ml: "ocaml",
  mli: "ocaml",
  nim: "nim",
  cmake: "cmake",
  tex: "latex",
  vim: "vim",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  makefile: "makefile",
}

/** Base filename (lowercased) → language, for the well-known files that carry
 * no extension. Matched after the extension lookup misses. */
export const LANG_BY_FILENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  vagrantfile: "ruby",
  brewfile: "ruby",
  jenkinsfile: "groovy",
}

/** Resolve a language from a bare (lowercased) filename — the exact table, then
 * the `Dockerfile.<variant>` / `Makefile.<variant>` prefix forms. */
function langFromFilename(baseLower: string): string | undefined {
  const exact = LANG_BY_FILENAME[baseLower]
  if (exact) return exact
  if (baseLower === "dockerfile" || baseLower.startsWith("dockerfile.")) return "dockerfile"
  if (baseLower === "makefile" || baseLower.startsWith("makefile.")) return "makefile"
  return undefined
}

/**
 * Infer a highlight.js language id from a file path. Tries the extension first,
 * then falls back to well-known extensionless filenames (Dockerfile, Makefile,
 * Gemfile, …). Returns undefined when nothing matches. Case-insensitive; handles
 * both `/` and `\` separators.
 */
export function langFromPath(filePath: string): string | undefined {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
  const baseLower = filePath.slice(slash + 1).toLowerCase()
  const dot = baseLower.lastIndexOf(".")
  // A leading dot (dotfile like `.bashrc`) is not an extension separator.
  if (dot > 0) {
    const byExt = LANG_BY_EXT[baseLower.slice(dot + 1)]
    if (byExt) return byExt
  }
  return langFromFilename(baseLower)
}

/**
 * Build a cli-highlight `Theme` from a palette's `code*` tokens, or undefined
 * when the palette uses plain ANSI names for every code token (the classic look
 * — defer to cli-highlight's built-in default so output is unchanged).
 */
export function paletteCodeTheme(palette: ThemePalette): Theme | undefined {
  const tokens = [
    palette.codeKeyword,
    palette.codeString,
    palette.codeNumber,
    palette.codeComment,
    palette.codeFunction,
    palette.codeBuiltin,
  ]
  const themed = tokens.some((c) => c.startsWith("#")) || palette.codeHighlight !== undefined
  if (!themed) return undefined
  const keyword = colorFn(palette.codeKeyword)
  return {
    keyword,
    built_in: colorFn(palette.codeBuiltin),
    type: colorFn(palette.codeBuiltin),
    literal: keyword,
    string: colorFn(palette.codeString),
    regexp: colorFn(palette.codeString),
    number: colorFn(palette.codeNumber),
    comment: colorFn(palette.codeComment),
    function: colorFn(palette.codeFunction),
    title: colorFn(palette.codeFunction),
    attr: colorFn(palette.codeNumber),
    name: colorFn(palette.codeBuiltin),
  }
}

/**
 * Highlight `code` for the given language. Unknown/unsupported languages and any
 * highlight.js error degrade gracefully to the original text. An optional
 * `theme` (from {@link paletteCodeTheme}) recolours tokens to match the UI.
 */
export function highlightCode(code: string, lang?: string, theme?: Theme): string {
  if (!code) return ""
  try {
    const language = lang && supportsLanguage(lang) ? lang : undefined
    return highlight(code, { language, ignoreIllegals: true, ...(theme ? { theme } : {}) })
  } catch {
    return code
  }
}

/**
 * Highlight a single line of code. Thin wrapper over {@link highlightCode} that
 * guarantees no trailing newline is introduced (so the caller can compose the
 * result inline). Returns the original text on empty/unknown input.
 */
export function highlightLine(code: string, lang?: string, theme?: Theme): string {
  if (!code) return code
  return highlightCode(code, lang, theme).replace(/\n+$/, "")
}

/** SGR foreground codes for the named palette colours (mirrors {@link NAMED}). */
const NAMED_FG: Record<string, string> = {
  black: "30",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  white: "37",
  gray: "90",
  grey: "90",
  redBright: "91",
  greenBright: "92",
  yellowBright: "93",
  blueBright: "94",
  magentaBright: "95",
  cyanBright: "96",
  whiteBright: "97",
}

/** Palette colour value (hex or ANSI keyword) → an SGR foreground parameter. */
function fgCode(color: string): string | undefined {
  if (color.startsWith("#") && /^#[0-9a-fA-F]{6}$/.test(color)) {
    const r = parseInt(color.slice(1, 3), 16)
    const g = parseInt(color.slice(3, 5), 16)
    const b = parseInt(color.slice(5, 7), 16)
    return `38;2;${r};${g};${b}`
  }
  return NAMED_FG[color]
}

const OPEN_FG = "["
const RESET_FG = "[39m"

/**
 * Re-tint an (already syntax-highlighted) string with an outer `color` so the
 * diff-role colour wins wherever the inner highlight does not assert its own.
 * Emits raw ANSI directly (not via chalk, which is a no-op passthrough under the
 * Jest mock and in non-TTY output) so the role colour is always present, and —
 * like chalk's nesting — rewrites each inner default-foreground reset (`[39m`)
 * back to `color`, so plain spans take the role colour while highlighted tokens
 * keep their own. An unknown colour returns the text untouched.
 */
export function tintAnsi(text: string, color: string): string {
  const code = fgCode(color)
  if (!code) return text
  const open = `${OPEN_FG}${code}m`
  const body = text.split(RESET_FG).join(RESET_FG + open)
  return `${open}${body}${RESET_FG}`
}
