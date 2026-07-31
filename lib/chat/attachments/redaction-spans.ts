/**
 * Split extracted attachment text into plain / redacted runs so the preview
 * panel's "model view" can highlight exactly what the PII gate replaced.
 *
 * We deliberately detect the emitted PLACEHOLDERS rather than keeping the
 * pre-redaction text around to diff against: the model view is rendered from
 * the same string that gets persisted into the chat draft, and holding the
 * un-redacted original there would defeat the point of redacting it.
 *
 * The pattern comes from `@cognia/redact`'s exported `PII_PLACEHOLDER_SOURCE`
 * so this scanner stays in lockstep with the kinds the redactor can emit.
 */

import { PII_PLACEHOLDER_SOURCE } from "@cognia/redact"

export interface TextSpan {
  text: string
  /** True for a `<KIND_NNN>` placeholder the redactor substituted in. */
  redacted: boolean
}

/**
 * Returns the text as alternating plain / placeholder runs. A string with no
 * placeholders yields a single plain span; an empty string yields no spans.
 */
export function splitRedactionSpans(text: string): TextSpan[] {
  if (!text) return []
  // Fresh regex per call: `g` regexes carry mutable `lastIndex` state, so a
  // module-level instance would desync across concurrent callers.
  const pattern = new RegExp(PII_PLACEHOLDER_SOURCE, "g")
  const spans: TextSpan[] = []
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index
    if (start > cursor) spans.push({ text: text.slice(cursor, start), redacted: false })
    spans.push({ text: match[0], redacted: true })
    cursor = start + match[0].length
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor), redacted: false })
  return spans
}

/** How many placeholders the redactor left in `text`. Drives the panel's note. */
export function countRedactions(text: string): number {
  if (!text) return 0
  return [...text.matchAll(new RegExp(PII_PLACEHOLDER_SOURCE, "g"))].length
}
