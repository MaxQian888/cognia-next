/**
 * The client secret Sign in with Apple expects: an ES256 JWT signed with the
 * team's `.p8` key (Apple "Creating a client secret").
 *
 * Better Auth takes it as a static string and Apple caps its lifetime at six
 * months, so a pre-minted secret would silently expire in production. It is
 * minted here from the key instead, short-lived, and reused within an
 * isolate until shortly before it expires.
 */

import { importPKCS8, SignJWT } from "jose"

import type { AppleCredentials } from "../config"

export const APPLE_AUDIENCE = "https://appleid.apple.com"

/** Lifetime of a minted secret. Apple allows up to 180 days. */
export const APPLE_SECRET_TTL_SECONDS = 24 * 60 * 60
/** Re-mint once less than this is left. */
const RENEW_BEFORE_SECONDS = 60 * 60

interface CachedSecret {
  fingerprint: string
  value: string
  expiresAt: number
}

let cached: CachedSecret | null = null

function fingerprintOf(credentials: AppleCredentials): string {
  return [
    credentials.teamId,
    credentials.serviceId,
    credentials.keyId,
    credentials.privateKey,
  ].join("\u0000")
}

/** PEM with literal `\n` sequences (how `wrangler secret put` often stores it) or real newlines. */
export function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n").trim() : pem.trim()
}

export async function mintAppleClientSecret(
  credentials: AppleCredentials,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  const fingerprint = fingerprintOf(credentials)
  if (
    cached &&
    cached.fingerprint === fingerprint &&
    cached.expiresAt - nowSeconds > RENEW_BEFORE_SECONDS
  ) {
    return cached.value
  }
  const key = await importPKCS8(normalizePem(credentials.privateKey), "ES256")
  const expiresAt = nowSeconds + APPLE_SECRET_TTL_SECONDS
  const value = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: credentials.keyId })
    .setIssuer(credentials.teamId)
    .setSubject(credentials.serviceId)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresAt)
    .sign(key)
  cached = { fingerprint, value, expiresAt }
  return value
}

/** Test seam: forget the memoised secret. */
export function resetAppleSecretCache(): void {
  cached = null
}
