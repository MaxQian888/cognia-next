// How many function definitions one model request may carry — pure helpers.
//
// OpenAI caps a request at 128 tools, and OpenAI-compatible gateways enforce
// the same cap (or a lower one) with a 400 such as
// "tools must contain at most 128 function definitions". A session with every
// tool category and a few plugins easily passes it, and some relays only
// enforce it on some upstreams, so the same session fails intermittently.
// The AI SDK dispatcher uses these helpers to keep each request under the cap:
// the protocol's documented limit up front, and the number an upstream reports
// when it rejects a request with a lower one.

/** Documented per-request tool caps, by AI SDK protocol family. */
const TOOL_LIMIT_BY_PROTOCOL: Readonly<Record<string, number>> = Object.freeze({
  openai: 128,
  azure: 128,
})

/** The per-request tool cap for a protocol family, or null when none is known. */
export function toolDefinitionLimitFor(protocol: string | null | undefined): number | null {
  if (typeof protocol !== "string") return null
  return TOOL_LIMIT_BY_PROTOCOL[protocol] ?? null
}

/** The tighter of two optional limits. */
export function tighterToolLimit(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

// Each pattern binds the number to a count of tools/functions, so a limit on
// something else ("tools[3].function.name must be at most 64 characters") is
// never read as a tool cap.
const LIMIT_PATTERNS: readonly RegExp[] = [
  // "tools must contain at most 128 function definitions"
  /\bat most (\d+) (?:function|tool)s?\b/i,
  // "a maximum of 128 tools", "up to 128 functions", "no more than 128 tools"
  /\b(?:maximum|max|up to|no more than|limit of) (?:of |number of |is )?(\d+) (?:function|tool)s?\b/i,
  // "too many tools; the maximum is 128", "number of tools exceeds the limit of 128"
  /\b(?:too many|number of) (?:function|tool)s?\b[^.]{0,60}?\b(?:maximum|max|limit|at most)\b(?: is| of)?:? (\d+)\b/i,
]

/**
 * The tool cap an upstream reported when it rejected a request for carrying
 * too many tools, or null when the error is about something else. Only a
 * positive cap counts; a message that mentions tools without a number is not
 * treated as a tool-count rejection.
 */
export function toolLimitFromError(message: unknown): number | null {
  if (typeof message !== "string" || message.length === 0) return null
  if (!/\b(?:function|tool)/i.test(message)) return null
  for (const pattern of LIMIT_PATTERNS) {
    const match = pattern.exec(message)
    if (!match) continue
    const limit = Number(match[1])
    if (Number.isInteger(limit) && limit > 0) return limit
  }
  return null
}
