/**
 * VS Code labels embed icons as `$(name)` or `$(name~spin)`, e.g.
 * `$(sync~spin) Indexing`. Split such a label into text and icon parts;
 * `$$(x)` is an escaped literal `$(x)`.
 */

export type CodiconSegment = { text: string } | { icon: string; spin: boolean }

const ICON = /\$\(([a-z0-9-]+)(~spin)?\)/gi

export function parseCodiconText(label: string): CodiconSegment[] {
  const segments: CodiconSegment[] = []
  let text = ""
  let last = 0
  for (const match of label.matchAll(ICON)) {
    const start = match.index ?? 0
    if (start > 0 && label[start - 1] === "$") {
      // Escaped: keep everything up to here, dropping the escaping `$`.
      text += label.slice(last, start - 1) + match[0]
      last = start + match[0].length
      continue
    }
    text += label.slice(last, start)
    if (text) segments.push({ text })
    text = ""
    segments.push({ icon: match[1].toLowerCase(), spin: Boolean(match[2]) })
    last = start + match[0].length
  }
  text += label.slice(last)
  if (text) segments.push({ text })
  return segments
}

/** The label with its icons removed, for accessible names and tooltips. */
export function stripCodicons(label: string): string {
  return parseCodiconText(label)
    .map((segment) => ("text" in segment ? segment.text : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
}
