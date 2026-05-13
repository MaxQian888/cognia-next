/**
 * GitHub webhook signature verification (x-hub-signature-256).
 *
 * Spec: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 * GitHub signs each payload with HMAC-SHA-256 keyed by the webhook's secret and
 * sends the digest in the `x-hub-signature-256` header as `sha256=<hex>`.
 *
 * This implementation is **timing-safe**: the comparison runs in constant time
 * relative to the input length, so an attacker cannot infer the correct digest
 * by measuring response times.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

const HEADER_PREFIX = "sha256="

/**
 * Verify a GitHub webhook signature header.
 *
 * @param body    Raw request body (string or Buffer). MUST be the unmodified body
 *                bytes — re-serialized JSON will produce a different digest.
 * @param header  Value of the `x-hub-signature-256` request header.
 * @param secret  The webhook's shared secret.
 * @returns       true iff the digest is valid for this secret.
 */
export function verifyGithubSignature(
  body: string | Buffer,
  header: string | null | undefined,
  secret: string
): boolean {
  if (!header || !secret || !header.startsWith(HEADER_PREFIX)) return false

  const expected = HEADER_PREFIX + computeGithubSignature(body, secret)
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Compute the hex digest portion (without the `sha256=` prefix). */
export function computeGithubSignature(body: string | Buffer, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex")
}
