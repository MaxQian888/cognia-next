/**
 * "Smart action at point" — what a Ctrl+click on the transcript should do.
 *
 * The frame buffer already knows the exact characters on screen, so the target
 * is resolved from the rendered row rather than from the cell model: whatever
 * you can see, you can click. Precedence, most specific first:
 *
 *   1. a file path under the pointer  → open it in `$EDITOR` (with `:line[:col]`)
 *   2. a URL under the pointer        → copy it (the TUI never opens a browser)
 *   3. anything else                  → copy the whole clicked row
 *
 * Pure: it takes the plain row text plus a column and returns an intent, so the
 * precedence rules unit-test without a terminal, a filesystem, or an editor.
 */
import { stringWidth } from "../markdown/width"

/** What a click at a given point resolved to. */
export type ClickTarget =
  | { kind: "file"; path: string; line?: number; col?: number }
  | { kind: "url"; url: string }
  | { kind: "line"; text: string }
  | { kind: "none" }

/**
 * Characters that can appear inside a clickable token. Deliberately excludes the
 * bracket/quote/comma punctuation that usually WRAPS a path in prose, so
 * `(see src/app.ts:12)` yields `src/app.ts:12` rather than the whole clause.
 */
const TOKEN_CHAR = /[^\s()[\]{}'"`,;]/

/**
 * True when `ch` can be part of a clickable token. Wide glyphs (CJK, emoji) are
 * treated as boundaries even though they are not punctuation: this TUI narrates
 * in Chinese, so `修改了src/app.ts` — with no separator — is the common shape,
 * and without this the token would swallow the prose and resolve to nothing.
 * The trade-off is that a genuinely CJK-named file is not click-openable; it
 * falls back to copying the row, which is the safe direction to fail in.
 */
function isTokenChar(ch: string): boolean {
  return TOKEN_CHAR.test(ch) && stringWidth(ch) === 1
}

/**
 * A path-like token, with an optional `:line` / `:line:col` suffix.
 * Requires either a directory separator or a file extension, so a bare word in
 * prose is not mistaken for a filename.
 */
const PATH_TOKEN =
  /^(~?[\w@.\-+]*(?:\/[\w@.\-+]+)+|[\w@\-+]+\.[A-Za-z][\w]*)(?::(\d+))?(?::(\d+))?$/

/** An http(s) URL. */
const URL_TOKEN = /^https?:\/\/\S+$/

/**
 * The whitespace-delimited token straddling display column `col`, or null when
 * the column lands on whitespace / past the end of the row.
 */
export function tokenAtColumn(line: string, col: number): string | null {
  // Walk once to map display columns onto characters (wide glyphs take two).
  const chars = [...line]
  let cursor = 0
  let index = -1
  for (let i = 0; i < chars.length; i++) {
    const width = stringWidth(chars[i])
    if (col >= cursor && col < cursor + width) {
      index = i
      break
    }
    cursor += width
  }
  if (index === -1 || !isTokenChar(chars[index])) return null
  let first = index
  while (first > 0 && isTokenChar(chars[first - 1])) first--
  let last = index
  while (last + 1 < chars.length && isTokenChar(chars[last + 1])) last++
  return chars.slice(first, last + 1).join("")
}

/**
 * Resolve the click. `exists` decides whether a path-shaped token is a real
 * file — injected so the resolver stays pure and the caller (which knows the
 * cwd) owns the filesystem probe. A path-shaped token that does not exist falls
 * through to the row copy rather than opening a bogus editor tab.
 */
export function resolveClickTarget(
  line: string,
  col: number,
  exists: (candidate: string) => boolean
): ClickTarget {
  const trimmed = line.trim()
  const token = tokenAtColumn(line, col)
  if (token) {
    if (URL_TOKEN.test(token)) return { kind: "url", url: token }
    const match = PATH_TOKEN.exec(token)
    if (match && exists(match[1])) {
      const line1 = match[2] ? Number(match[2]) : undefined
      const col1 = match[3] ? Number(match[3]) : undefined
      return {
        kind: "file",
        path: match[1],
        ...(line1 === undefined ? {} : { line: line1 }),
        ...(col1 === undefined ? {} : { col: col1 }),
      }
    }
  }
  return trimmed ? { kind: "line", text: trimmed } : { kind: "none" }
}
