/**
 * Standard Webhooks signing (https://www.standardwebhooks.com/).
 *
 * Signs the literal string `{id}.{timestamp}.{body}` with HMAC-SHA256, base64,
 * and emits the `webhook-id` / `webhook-timestamp` / `webhook-signature` header
 * trio. Folding id + timestamp into the signed content (vs signing the body
 * alone) is what closes the replay window — receivers reject stale timestamps.
 *
 * Sign the EXACT body bytes the caller will send — never a re-serialized copy
 * (whitespace / key-order / Unicode-normalization drift breaks verification).
 *
 * Web Crypto is available in both runtimes we target — the browser tab and the
 * Node test environment (jest.setup polyfills `crypto.subtle`).
 */

const HMAC = { name: "HMAC", hash: "SHA-256" } as const

/** Returns the base64 HMAC-SHA256 of `{id}.{timestamp}.{body}`. */
export async function signStandardWebhook(
  id: string,
  timestamp: number,
  body: string,
  secret: string
): Promise<string> {
  if (!secret) throw new Error("signStandardWebhook: secret is required")
  const enc = new TextEncoder()
  const toSign = `${id}.${timestamp}.${body}`
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), HMAC, false, ["sign"])
  const mac = await crypto.subtle.sign(HMAC.name, key, enc.encode(toSign))
  return bytesToBase64(new Uint8Array(mac))
}

/** Builds the Standard Webhooks header trio for a delivery. */
export async function buildSignedHeaders(
  id: string,
  timestamp: number,
  body: string,
  secret: string
): Promise<Record<string, string>> {
  const sig = await signStandardWebhook(id, timestamp, body, secret)
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${sig}`,
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
