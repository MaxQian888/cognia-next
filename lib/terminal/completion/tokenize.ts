/**
 * Quote-aware tokenizer for the terminal completion providers (path / exe /
 * spec). Best-effort shell-line lexing — enough to find the token under the
 * cursor and its unquoted value, NOT a full shell grammar.
 *
 * Quoting rules:
 *   * `"…"` and `'…'` group; an unterminated quote runs to end of line
 *     (the common case while still typing).
 *   * With `backslashEscapes` (POSIX shells), `\x` outside single quotes
 *     escapes `x` (so `My\ Folder` is one token). Windows shells treat
 *     `\` as a path separator, so the flag must be off there.
 *
 * Pure + synchronous so the providers stay unit-testable without xterm.
 */

import type { ShellKind } from "@/lib/terminal/shell-detect"

export interface LineToken {
  /** The token text exactly as typed (quotes/escapes preserved). */
  raw: string
  /** The unquoted/unescaped value. */
  value: string
  /** Offset of the first char of `raw` within the line. */
  start: number
  /** End offset (exclusive). */
  end: number
}

export interface TokenizeOptions {
  /** POSIX-style `\ ` escaping. Default false. */
  backslashEscapes?: boolean
}

/** Whether `\` escapes for this shell family (POSIX yes, Windows no). */
export function shellUsesBackslashEscapes(shell: ShellKind): boolean {
  switch (shell) {
    case "bash":
    case "zsh":
    case "sh":
    case "fish":
      return true
    default:
      return false
  }
}

/** Lex a (partial) command line into tokens. */
export function tokenize(line: string, opts: TokenizeOptions = {}): LineToken[] {
  const escapes = opts.backslashEscapes ?? false
  const tokens: LineToken[] = []
  let i = 0
  const n = line.length

  while (i < n) {
    // Skip inter-token whitespace.
    while (i < n && (line[i] === " " || line[i] === "\t")) i++
    if (i >= n) break

    const start = i
    let value = ""
    let quote: '"' | "'" | null = null
    while (i < n) {
      const ch = line[i]
      if (quote) {
        if (ch === quote) {
          quote = null
          i++
          continue
        }
        if (escapes && quote === '"' && ch === "\\" && i + 1 < n) {
          // POSIX: inside double quotes, backslash escapes `"` and `\`.
          const next = line[i + 1]
          if (next === '"' || next === "\\") {
            value += next
            i += 2
            continue
          }
        }
        value += ch
        i++
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        i++
        continue
      }
      if (escapes && ch === "\\" && i + 1 < n) {
        value += line[i + 1]
        i += 2
        continue
      }
      if (ch === " " || ch === "\t") break
      value += ch
      i++
    }
    tokens.push({ raw: line.slice(start, i), value, start, end: i })
  }
  return tokens
}

/**
 * The token under the cursor, or a zero-width empty token at the cursor
 * when it sits on whitespace (e.g. `cd |` → completing a fresh argument).
 * Returns null only for a cursor outside the line bounds.
 */
export function tokenAtCursor(
  line: string,
  cursor: number,
  opts: TokenizeOptions = {}
): { token: LineToken; index: number } | null {
  if (cursor < 0 || cursor > line.length) return null
  const tokens = tokenize(line, opts)
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]
    if (cursor >= t.start && cursor <= t.end) {
      return { token: t, index: idx }
    }
  }
  // Cursor past the last token on trailing whitespace → fresh empty token.
  const index = tokens.length
  return {
    token: { raw: "", value: "", start: cursor, end: cursor },
    index,
  }
}
