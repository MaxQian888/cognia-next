export const NETWORK_BODY_LIMIT_BYTES = 64 * 1024

// Keep in step with `REDACTED_HEADERS` in lib/browser/protocol.ts (the tool
// surface re-applies the same set as defense in depth).
export const REDACTED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
])

/** Replace credential-bearing header values; names are kept so agents see they existed. */
export function redactHeaders(headers = {}) {
  const redacted = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    redacted[name] = REDACTED_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : String(value)
  }
  return redacted
}

function isTextual(contentType) {
  const value = String(contentType ?? "").toLowerCase()
  return (
    value.startsWith("text/") ||
    /json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|svg/.test(value)
  )
}

/**
 * Truncate a response body to `limit` bytes. Textual bodies come back as UTF-8
 * (a split trailing code point is dropped), anything else as base64.
 */
export function encodeBody(bytes, contentType, limit = NETWORK_BODY_LIMIT_BYTES) {
  if (bytes == null) return { body: null, bodyEncoding: null, truncated: false, bodyBytes: 0 }
  const buffer = Buffer.from(bytes)
  const truncated = buffer.length > limit
  const slice = truncated ? buffer.subarray(0, limit) : buffer
  if (isTextual(contentType)) {
    return {
      body: new TextDecoder("utf-8", { fatal: false }).decode(slice).replace(/�$/, ""),
      bodyEncoding: "utf8",
      truncated,
      bodyBytes: buffer.length,
    }
  }
  return {
    body: slice.toString("base64"),
    bodyEncoding: "base64",
    truncated,
    bodyBytes: buffer.length,
  }
}
