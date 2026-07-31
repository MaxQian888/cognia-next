/**
 * Pure helpers for rendering a tool/file result body with syntax highlighting,
 * optional line numbers, and a line-based cap. Shared by the inline transcript
 * view ({@link CellView}'s `ResultBody`) and the full-output pager so the look
 * is identical in both places. No Ink, no I/O — every input is injected, so the
 * whole module unit-tests without rendering.
 *
 * Reuses the existing highlight stack: {@link highlightCode} + {@link langFromPath}
 * + {@link paletteCodeTheme} (see `markdown/highlight.ts`).
 */
import { highlightCode, langFromPath, paletteCodeTheme } from "../markdown/highlight"
import type { ThemePalette } from "../theme/palette"

/** Shell-ish tools whose output we colour as a shell session. */
const SHELL_TOOLS = new Set(["bash", "shell", "sh"])
/** PowerShell-flavoured tool names (Windows shell-outs). */
const POWERSHELL_TOOLS = new Set(["powershell", "pwsh", "ps"])
/** File-content tools whose result is the file body (language from its path). */
const FILE_TOOLS = new Set(["read", "cat", "view", "open"])

/** First string field present among the candidate keys. */
function firstPath(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = input[key]
    if (typeof v === "string" && v.length > 0) return v
  }
  return undefined
}

/**
 * Infer a highlight.js language id for a tool's RESULT body. File-read tools key
 * off the file path's extension; shell tools colour as `bash`/`powershell`;
 * everything else returns undefined (the result is rendered as plain text).
 */
export function toolResultLang(
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  const name = toolName.toLowerCase()
  if (SHELL_TOOLS.has(name)) return "bash"
  if (POWERSHELL_TOOLS.has(name)) return "powershell"
  if (FILE_TOOLS.has(name)) {
    const path = firstPath(input, ["file_path", "filePath", "path", "notebook_path"])
    return path ? langFromPath(path) : undefined
  }
  // Generic fallback: if some path-like field is present, infer from it (covers
  // MCP/plugin file tools that don't match the builtin names above).
  const path = firstPath(input, ["file_path", "filePath", "path"])
  return path ? langFromPath(path) : undefined
}

export interface RenderResultOptions {
  /** highlight.js language id, or undefined to skip highlighting. */
  lang?: string
  /** Whether to syntax-highlight at all (the render pref toggle). */
  highlight?: boolean
  /** Prefix each line with a right-aligned 1-based line number. */
  lineNumbers?: boolean
  /** Palette for theme-aware code colours; falls back to cli-highlight default. */
  palette?: ThemePalette
  /** Max lines to emit; the remainder is reported as `hiddenLines`. */
  maxLines?: number
}

export interface RenderedResult {
  /** The rendered lines (highlighted + numbered as requested), capped. */
  lines: string[]
  /** How many lines were dropped by the `maxLines` cap (0 when none). */
  hiddenLines: number
  /** Total line count of the input before capping. */
  totalLines: number
}

/** Right-align a 1-based line number in a gutter wide enough for `total`. */
function gutter(n: number, width: number): string {
  return String(n).padStart(width) + " │ "
}

/**
 * Render a result body into display-ready lines. Highlighting (when enabled and
 * a language is known) is applied per the whole body so multi-line constructs
 * colour correctly, then split back into lines so line numbers and the cap apply
 * to the visible rows. Empty input yields an empty result.
 */
export function renderResultLines(text: string, opts: RenderResultOptions = {}): RenderedResult {
  const { lang, highlight = true, lineNumbers = false, palette, maxLines } = opts
  if (text.length === 0) return { lines: [], hiddenLines: 0, totalLines: 0 }

  const rawLines = text.split("\n")
  const totalLines = rawLines.length

  // Highlight the whole body once (preserves multi-line tokens), then re-split.
  // `highlightCode` keeps the text content byte-for-byte (only ANSI added), so
  // the split count matches `rawLines` exactly.
  let displayLines = rawLines
  if (highlight && lang) {
    const theme = palette ? paletteCodeTheme(palette) : undefined
    const highlighted = highlightCode(text, lang, theme)
    const split = highlighted.replace(/\n$/, "").split("\n")
    if (split.length === totalLines) displayLines = split
  }

  const cap = maxLines && maxLines > 0 ? Math.min(maxLines, totalLines) : totalLines
  const hiddenLines = totalLines - cap

  const width = String(totalLines).length
  const out: string[] = []
  for (let i = 0; i < cap; i++) {
    out.push(lineNumbers ? gutter(i + 1, width) + displayLines[i] : displayLines[i])
  }
  return { lines: out, hiddenLines, totalLines }
}

/** Coerce an arbitrary tool result into its display text (string verbatim, else JSON). */
export function resultToText(result: unknown): string {
  if (result == null) return ""
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
