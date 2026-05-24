import type { ParsedError, ParsedNode } from "../types"

// Anthropic API error `type` → HTTP status code.
// https://docs.anthropic.com/en/api/errors
const STATUS_BY_TYPE: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
}

// One-line, actionable hint per error type — surfaced after the API message.
const HINT_BY_TYPE: Record<string, string> = {
  authentication_error: "Check your API key / OAuth token in Settings.",
  permission_error: "Your account lacks access to this resource or model.",
  rate_limit_error: "You hit a rate limit — wait a moment and retry.",
  request_too_large: "The request exceeds the size limit — shorten the input.",
  overloaded_error: "Anthropic is overloaded — retry shortly.",
  invalid_request_error: "The request was malformed — check the parameters.",
}

/**
 * Parse a structured Anthropic API error envelope —
 * `{"type":"error","error":{"type":"rate_limit_error","message":"…"}}` — into a
 * `statusCode` node (mapped from the error type) plus a `text` node carrying the
 * message and an actionable hint. Reuses the existing `statusCode` renderer
 * (colour-coded badge) and `text` renderer; returns `null` for anything that is
 * not a recognised Anthropic error envelope so generic JSON still falls through
 * to the JSON tree renderer.
 */
export const anthropicErrorParser = {
  name: "anthropic-error",

  parse(text: string): ParsedError | null {
    const trimmed = text.trim()
    if (!trimmed.startsWith("{") || !trimmed.includes('"error"')) return null

    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      return null
    }

    const envelope = obj as { type?: unknown; error?: { type?: unknown; message?: unknown } }
    if (envelope.type !== "error" || !envelope.error || typeof envelope.error !== "object") {
      return null
    }
    const errType = typeof envelope.error.type === "string" ? envelope.error.type : null
    if (!errType) return null

    const status = STATUS_BY_TYPE[errType] ?? 500
    const message = typeof envelope.error.message === "string" ? envelope.error.message : errType
    const hint = HINT_BY_TYPE[errType]

    const nodes: ParsedNode[] = [
      { kind: "statusCode", content: `${status} ${errType}`, status },
      { kind: "text", content: hint ? `${message}\n${hint}` : message },
    ]
    return { nodes, parsed: true }
  },
}
