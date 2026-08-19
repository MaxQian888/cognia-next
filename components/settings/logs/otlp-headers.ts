/**
 * Single-line text ⇄ headers map for the OTLP exporter field.
 *
 * The parser deliberately tolerates trailing commas and stray whitespace so a
 * value pasted out of a `curl -H` example round-trips, and it drops the
 * credential headers outright: those belong in the keyring-backed secret
 * fields, not in a plaintext settings string that gets persisted to
 * localStorage and included in support bundles.
 */

const BLOCKED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
])

export function serializeHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ")
}

export function parseHeaders(value: string): Record<string, string> {
  if (!value || !value.trim()) return {}

  const out: Record<string, string> = {}
  for (const chunk of value.split(",")) {
    const colon = chunk.indexOf(":")
    if (colon <= 0) continue
    const key = chunk.slice(0, colon).trim()
    const headerValue = chunk.slice(colon + 1).trim()
    if (key.length > 0 && !BLOCKED_HEADERS.has(key.toLowerCase())) {
      out[key] = headerValue
    }
  }
  return out
}
