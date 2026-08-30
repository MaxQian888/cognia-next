/**
 * Extract the first JSON value out of an LLM response.
 *
 * Lives here rather than in `lib/twin/distill/llm.ts` because it was the ONLY
 * runtime value the eval scorers imported from the app: every other symbol
 * crossing that boundary was a type. Moving it is what lets the judge and RAG
 * scorers compile inside this zero-`@/` package. The twin distiller re-exports
 * it, so its callers are unchanged.
 */

/**
 * Tolerates leading prose, fenced ``` blocks, and trailing commentary — common
 * when the model is asked for "JSON only" but slips in a sentence either side.
 *
 * Throws when no parseable JSON is found so callers can surface a clear
 * "LLM returned non-JSON" error instead of swallowing the failure silently.
 */
export function extractJson<T>(text: string): T {
  const trimmed = text.trim()
  // Try fenced block first.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i)
  if (fenced) {
    return JSON.parse(fenced[1]) as T
  }
  // Find the first balanced { … } or [ … ] span.
  const start = trimmed.search(/[{[]/)
  if (start === -1) {
    throw new Error(`extractJson: no JSON object or array found in response`)
  }
  // Walk forward respecting nested brackets so we don't trip on stray
  // braces inside string literals. Best-effort but plenty for distill output.
  const opener = trimmed[start]
  const closer = opener === "{" ? "}" : "]"
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === opener) depth += 1
    else if (ch === closer) {
      depth -= 1
      if (depth === 0) {
        return JSON.parse(trimmed.slice(start, i + 1)) as T
      }
    }
  }
  throw new Error("extractJson: unterminated JSON span in response")
}
