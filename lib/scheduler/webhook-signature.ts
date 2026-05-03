/**
 * Webhook signing helper.
 *
 * Computes an HMAC-SHA256 over the JSON body so receivers can verify a
 * delivery actually came from this cognia-next install (and not a replay or
 * forgery on an open ingestion endpoint). The signature is sent in the
 * `X-Cognia-Signature` header in the `sha256=<hex>` shape that GitHub /
 * Stripe / Linear / Slack receivers already understand.
 *
 * Web Crypto is available in both runtimes we target — the browser tab
 * (Next.js client) and Node 18+ test environment (jest.setup.ts polyfills
 * `crypto.subtle` from `node:crypto`'s webcrypto). The Tauri webview
 * already exposes the same API, so no isolation layer is needed.
 */

const HMAC_ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const

/**
 * Sign the given body with the given secret. Returns lowercase hex (64 chars).
 *
 * Throws when called with an empty secret — the caller (notification
 * integration) is expected to skip signing when no secret is configured
 * rather than passing through an empty string. This makes "secret accidentally
 * cleared but signature still claimed" detectable instead of silent.
 */
export async function signWebhookBody(body: string, secret: string): Promise<string> {
  if (!secret) {
    throw new Error("signWebhookBody: secret is required")
  }
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), HMAC_ALGORITHM, false, [
    "sign",
  ])
  const signature = await crypto.subtle.sign(HMAC_ALGORITHM.name, key, encoder.encode(body))
  return bytesToHex(new Uint8Array(signature))
}

/** Convenience helper that produces the full header value (`sha256=<hex>`). */
export async function buildWebhookSignatureHeader(body: string, secret: string): Promise<string> {
  const hex = await signWebhookBody(body, secret)
  return `sha256=${hex}`
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0")
  }
  return out
}
