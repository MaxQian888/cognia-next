import type { ParsedError, ParsedNode } from "../types"

// HTTP status → stable category id (drives the localized hint on the badge).
const STATUS_CATEGORY: Record<number, string> = {
  400: "invalidRequest",
  401: "unauthorized",
  403: "forbidden",
  404: "notFound",
  413: "payloadTooLarge",
  429: "rateLimited",
  500: "serverError",
  502: "serviceUnavailable",
  503: "serviceUnavailable",
  504: "serviceUnavailable",
  529: "modelOverloaded",
}

// A 3-digit HTTP status, but ONLY when clearly a status: prefixed by
// `HTTP…` / `status [code]` / `error` / `code`, or immediately followed by a
// known reason phrase. Keeps stray 3-digit numbers (ports, durations, ids)
// from being mistaken for statuses.
const STATUS_RE =
  /(?:\bHTTP\S*\s+|\bstatus(?:\s+code)?\s*[:=]?\s*|\berror\s+|\bcode\s+)(\d{3})\b|\b(\d{3})\s+(?:Bad Request|Unauthorized|Payment Required|Forbidden|Not Found|Method Not Allowed|Request Timeout|Conflict|Gone|Payload Too Large|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i

// Provider / AI-SDK keyword signals that carry no numeric status.
const KEYWORD_RULES: ReadonlyArray<{ re: RegExp; category: string }> = [
  { re: /\binvalid[_ ]request(?:[_ ]error)?\b/i, category: "invalidRequest" },
  { re: /model[_ ]?overloaded|overloaded[_ ]?error|\boverloaded\b/i, category: "modelOverloaded" },
  {
    re: /exceeded your current quota|insufficient[_ ]quota|\bquota\b/i,
    category: "quotaExceeded",
  },
  { re: /rate[_ ]?limit(?:ed|_error)?|too many requests/i, category: "rateLimited" },
  {
    re: /\bunauthorized\b|authentication[_ ]?error|invalid[_ ]api[_ ]key/i,
    category: "unauthorized",
  },
  { re: /\bforbidden\b|permission[_ ]?error|permission denied/i, category: "forbidden" },
]

/**
 * Recognise generic HTTP / provider API failures in plain-text error messages
 * (the structured Anthropic JSON envelope is already claimed earlier by
 * `anthropicErrorParser`). A numeric status yields a colour-coded `statusCode`
 * badge carrying a category id for its hint; keyword-only signals
 * (`model_overloaded`, `quota`, `rate limit`, …) yield a `category` badge. The
 * original message is preserved in a trailing `text` node. Returns `null` when
 * nothing matches.
 */
export const apiStatusErrorParser = {
  name: "api-status-error",

  parse(text: string): ParsedError | null {
    const m = STATUS_RE.exec(text)
    if (m) {
      const status = Number(m[1] ?? m[2])
      if (status >= 400 && status <= 599) {
        const category = STATUS_CATEGORY[status]
        const statusNode: ParsedNode = {
          kind: "statusCode",
          content: String(status),
          status,
          ...(category ? { category } : {}),
        }
        return { nodes: [statusNode, { kind: "text", content: text }], parsed: true }
      }
    }

    for (const rule of KEYWORD_RULES) {
      if (rule.re.test(text)) {
        return {
          nodes: [
            { kind: "category", content: text.trim(), category: rule.category },
            { kind: "text", content: text },
          ],
          parsed: true,
        }
      }
    }

    return null
  },
}
