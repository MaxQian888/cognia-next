/**
 * Collapse a large multi-line paste into a compact `[Pasted N lines]`
 * placeholder, keeping the full text aside so it can be re-expanded on submit.
 * Pure: the caller supplies the placeholder id (a counter) so there is no
 * reliance on Math.random / Date.now.
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

export function collapsePaste(text: string, id: number, threshold = 4): PasteResult {
  const lineCount = text.split("\n").length
  if (lineCount <= threshold) {
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
