/**
 * Tolerant JSON extraction for LLM output. Mirrors the behaviour of the core
 * `extractJson` helper but is re-implemented locally so the plugin imports
 * nothing from `@/lib/*` (zero coupling).
 *
 * Strategy, in order:
 *   1. A fenced ```json ... ``` (or bare ``` ... ```) code block.
 *   2. The first balanced `{ ... }` or `[ ... ]` span, respecting string
 *      literals + escapes so stray braces inside strings don't trip it.
 * Throws when neither yields parseable JSON.
 */
export function extractJson<T>(text: string): T {
  const fenced = extractFenced(text)
  if (fenced !== null) {
    try {
      return JSON.parse(fenced) as T
    } catch {
      // fall through to the balanced-span scan
    }
  }

  const span = extractBalancedSpan(text)
  if (span !== null) {
    return JSON.parse(span) as T
  }

  // Last resort: maybe the whole string is JSON.
  return JSON.parse(text.trim()) as T
}

/** Like `extractJson` but returns a fallback instead of throwing. */
export function tryExtractJson<T>(text: string, fallback: T): T {
  try {
    return extractJson<T>(text)
  } catch {
    return fallback
  }
}

function extractFenced(text: string): string | null {
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i)
  if (!match) return null
  const body = match[1].trim()
  return body.length > 0 ? body : null
}

function extractBalancedSpan(text: string): string | null {
  const start = firstOpener(text)
  if (start === -1) return null

  const open = text[start]
  const close = open === "{" ? "}" : "]"
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function firstOpener(text: string): number {
  const brace = text.indexOf("{")
  const bracket = text.indexOf("[")
  if (brace === -1) return bracket
  if (bracket === -1) return brace
  return Math.min(brace, bracket)
}
