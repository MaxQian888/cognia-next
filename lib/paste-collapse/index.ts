/**
 * Collapse a large multi-line paste into a compact `[Pasted N lines]`
 * placeholder, keeping the full text aside so it can be re-expanded on submit.
 * Pure: the caller supplies the placeholder id (a counter) so there is no
 * reliance on Math.random / Date.now.
 *
 * Shared by the web composer (`components/chat/composer.tsx`) and the CLI TUI
 * input (`cli/src/tui/components/Input.tsx`) so both fold oversized pastes the
 * same way.
 */
export interface PasteResult {
  isLarge: boolean
  lineCount: number
  /** What to show in the editor (placeholder when large, else the text). */
  display: string
  /** The full pasted text (always preserved). */
  stored: string
}

export function placeholderFor(lineCount: number, id: number): string {
  return `[Pasted ${lineCount} lines #${id}]`
}

/**
 * Returns all `[Pasted N lines #k]` placeholders present in `text`, in order.
 * Owns the placeholder shape alongside {@link placeholderFor} so callers (e.g.
 * the composer's orphaned-placeholder reminder) don't re-encode the format with
 * their own regex and silently break if the placeholder wording ever changes.
 * A fresh RegExp is built per call because the global flag carries mutable
 * `lastIndex` state that a shared instance would corrupt across call sites.
 */
export function findPastePlaceholders(text: string): string[] {
  return text.match(/\[Pasted \d+ lines #\d+\]/g) ?? []
}

/**
 * Character budget above which a paste collapses even when it has few lines.
 * Bracketed paste (`input/bracketed-paste.ts`) surfaces a paste atomically, so a
 * single huge line (e.g. a minified blob or a long URL list) would otherwise
 * slip past the line-count threshold and flood the composer. 800 chars ≈ the
 * point where a paste stops being a normal edit and starts being a payload.
 */
export const PASTE_CHAR_THRESHOLD = 800

export function collapsePaste(
  text: string,
  id: number,
  threshold = 4,
  charThreshold = PASTE_CHAR_THRESHOLD
): PasteResult {
  const lineCount = text.split("\n").length
  // Collapse when EITHER the line count or the character length crosses its
  // threshold, so a single very long line still collapses to a placeholder.
  if (lineCount <= threshold && text.length < charThreshold) {
    return { isLarge: false, lineCount, display: text, stored: text }
  }
  return { isLarge: true, lineCount, display: placeholderFor(lineCount, id), stored: text }
}

/** Replace any `[Pasted N lines #k]` placeholders in `text` with their full bodies. */
export function expandPastes(text: string, pastes: Record<string, string>): string {
  let out = text
  for (const [placeholder, body] of Object.entries(pastes)) {
    if (out.includes(placeholder)) out = out.split(placeholder).join(body)
  }
  return out
}
