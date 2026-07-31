/**
 * Trailer extraction for self-paced `/loop` iterations.
 *
 * The model is instructed (see `prompts.ts`) to end each reply with a
 * single-line JSON object. Extraction reuses the canonical tolerant parser
 * (`extractJson` from `lib/twin/distill/llm` — fenced block first, then the
 * first balanced span) and is **fail-OPEN**: anything missing or malformed
 * returns `null` and the caller continues at the minimum delay, bumping
 * `parseFailureCount` until `maxParseFailures` exits the loop as `error`.
 */

import { extractJson } from "@/lib/twin/distill/llm"

export interface LoopTrailer {
  /** False → the model declared the task complete; the loop ends. */
  continue: boolean
  /** Clamped by the caller into [minDelayMs, maxDelayMs]. */
  delayMs?: number
  reason?: string
}

/**
 * Parse the trailer from a model response. Never throws.
 *
 * The JSON may legitimately appear anywhere in the reply (models often
 * prepend prose); `extractJson` finds the first balanced object — when that
 * object doesn't carry a boolean `continue`, we scan the remaining text for
 * a later candidate before giving up, so an unrelated JSON snippet earlier
 * in the reply doesn't shadow the trailer.
 */
export function parseLoopTrailer(text: string): LoopTrailer | null {
  let remaining = text
  for (let attempts = 0; attempts < 5; attempts++) {
    let candidate: unknown
    try {
      candidate = extractJson<unknown>(remaining)
    } catch {
      return null
    }
    const trailer = coerceTrailer(candidate)
    if (trailer) return trailer
    // Skip past this candidate's opening bracket and rescan.
    const start = remaining.search(/[{[]/)
    if (start === -1) return null
    remaining = remaining.slice(start + 1)
  }
  return null
}

function coerceTrailer(value: unknown): LoopTrailer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  if (typeof obj.continue !== "boolean") return null
  const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : undefined
  if (!obj.continue) {
    return { continue: false, ...(reason ? { reason } : {}) }
  }
  const seconds = typeof obj.delaySeconds === "number" ? obj.delaySeconds : undefined
  const delayMs = seconds !== undefined && Number.isFinite(seconds) ? seconds * 1_000 : undefined
  return {
    continue: true,
    ...(delayMs !== undefined ? { delayMs } : {}),
    ...(reason ? { reason } : {}),
  }
}
