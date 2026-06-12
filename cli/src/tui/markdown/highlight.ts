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
