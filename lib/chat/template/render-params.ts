// Turning `{{parameter}}` tokens into their values on the way out.
//
// This runs on the ranges the composer already recognised as chips, not on a
// fresh scan of the outgoing text. That matters twice over:
//
//   - Code stays code. The chip pass already excluded fenced blocks and inline
//     spans, so a Jinja config the user pasted is substituted here exactly as
//     often as it was highlighted: never.
//   - The two argument syntaxes never cross. A `/command`'s arguments are not
//     chips, so `{{x}}` inside them is left for `applyTemplate`'s own
//     `$1` / `$ARGUMENTS` pass. Two substitution engines over one string is how
//     a value that happens to contain `$1` gets mangled.

import type { ParamSegment } from "@/lib/slash-commands/parse-segments"
import { paramValueText, type ChatTemplateBinding } from "./binding"

export interface RenderParamsResult {
  text: string
  /** True when at least one token was replaced, so callers can re-parse. */
  changed: boolean
}

/**
 * Replace each token in `tokens` with its bound value.
 *
 * An unfilled parameter is left as its literal token rather than collapsing to
 * an empty string. Silently deleting it would produce a sentence with a hole in
 * it that reads as finished — the caller is expected to refuse the send instead
 * (see `unfilledParams`), and a visible `{{module}}` is the better failure if
 * one ever slips through.
 */
export function renderParamTokens(
  text: string,
  tokens: readonly ParamSegment[],
  binding: ChatTemplateBinding | undefined
): RenderParamsResult {
  if (tokens.length === 0) return { text, changed: false }

  let out = ""
  let cursor = 0
  let changed = false
  // `tokens` arrives in source order from `splitParamSegments`; sorting defends
  // a caller that filtered or re-ordered it, since one out-of-order range would
  // silently duplicate a slice of the message.
  for (const token of [...tokens].sort((a, b) => a.start - b.start)) {
    if (token.start < cursor) continue
    const value = binding?.params[token.paramId]
    const replacement = value ? paramValueText(value) : token.raw
    out += text.slice(cursor, token.start) + replacement
    if (replacement !== token.raw) changed = true
    cursor = token.end
  }
  out += text.slice(cursor)
  return { text: out, changed }
}
