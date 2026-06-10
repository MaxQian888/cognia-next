/**
 * Syntax highlighting for fenced code blocks via `cli-highlight` (highlight.js,
 * CJS). Returns an ANSI-colored string that Ink's `<Text>` renders verbatim;
 * the text content is preserved exactly (only color escapes are added), so the
 * line still measures and wraps correctly after stripping.
 */
import { highlight, supportsLanguage } from "cli-highlight"

const ANSI_RE = /\[[0-9;]*m/g

/** Remove ANSI color escapes — used for width measurement and test assertions. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

/**
 * Highlight `code` for the given language. Unknown/unsupported languages and any
 * highlight.js error degrade gracefully to the original text.
 */
export function highlightCode(code: string, lang?: string): string {
  if (!code) return ""
  try {
    const language = lang && supportsLanguage(lang) ? lang : undefined
    return highlight(code, { language, ignoreIllegals: true })
  } catch {
    return code
  }
}
