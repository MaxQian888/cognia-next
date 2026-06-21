import type { ParsedError, ParsedNode } from "../types"

/**
 * errno / network signals → stable category id. The list is ordered most- to
 * least-specific; the first rule that matches wins. `timeout` requires the
 * `ETIMEDOUT` errno or the word "time(d) out" next to a network noun so a bare
 * "timeout" in unrelated text doesn't get mis-categorised.
 */
const NETWORK_RULES: ReadonlyArray<{ re: RegExp; category: string }> = [
  { re: /\bECONNREFUSED\b|connection refused/i, category: "connectionRefused" },
  { re: /\bECONNRESET\b|connection reset|socket hang ?up/i, category: "connectionReset" },
  { re: /\b(?:ENOTFOUND|EAI_AGAIN)\b|getaddrinfo|dns lookup failed/i, category: "dnsFailure" },
  {
    re: /\b(?:EHOSTUNREACH|ENETUNREACH)\b|network is unreachable|host is unreachable/i,
    category: "networkUnreachable",
  },
  { re: /\bEPIPE\b|broken pipe/i, category: "brokenPipe" },
  {
    re: /\bETIMEDOUT\b|(?:network|request|connection|socket|fetch)[^\n]{0,40}timed?\s*out|timed?\s*out[^\n]{0,40}(?:network|request|connection|socket|fetch)/i,
    category: "timeout",
  },
  { re: /failed to fetch|fetch failed/i, category: "fetchFailed" },
]

/**
 * Recognise network / connection failures (Node errno codes, `socket hang up`,
 * `Failed to fetch`, DNS lookup failures, timeouts) and emit a `category` badge
 * node carrying a stable id plus a `text` node with the original message so the
 * downstream path/URL/log parsers can still enrich it. Returns `null` when no
 * network signal is present.
 */
export const networkErrorParser = {
  name: "network-error",

  parse(text: string): ParsedError | null {
    for (const rule of NETWORK_RULES) {
      if (rule.re.test(text)) {
        const nodes: ParsedNode[] = [
          { kind: "category", content: text.trim(), category: rule.category },
          { kind: "text", content: text },
        ]
        return { nodes, parsed: true }
      }
    }
    return null
  },
}
