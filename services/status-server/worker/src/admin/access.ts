/**
 * Cloudflare Access identity for the operator API, validated inside the
 * Worker (plan §8). The edge also protects `/api/status/v1/admin/*`, but the
 * handler never relies on that: an alternate route (workers.dev, staging)
 * or a request that skipped Access still needs a valid token here.
 *
 * - Token: the `Cf-Access-Jwt-Assertion` header Access forwards (or the
 *   `CF_Authorization` cookie of a browser session).
 * - Signature: RS256 against the team's JWKS at
 *   `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`. The issuer and the JWKS
 *   URL come only from configuration, never from the request or the token.
 *   Keys are cached in memory for `JWKS_TTL_MS`; an unknown `kid` refetches
 *   once (at most every `JWKS_REFETCH_MIN_MS`, so random kids cannot turn
 *   requests into JWKS fetches).
 * - Claims: `iss` equals the team domain, `aud` contains `ACCESS_AUD`,
 *   `exp` / `nbf` hold with 60 s of clock skew, and the `email` claim is in
 *   `ADMIN_EMAILS` (case-insensitive). Service tokens carry no email claim
 *   and are therefore refused: they would need their own explicit,
 *   scoped verification.
 * - Missing configuration (team domain, audience or allowlist): every admin
 *   request is 503 `unavailable`. There is no unauthenticated fallback.
 */

import { base64UrlToBytes } from "../../../../../lib/status/signing"
import type { Env } from "../env"

export const JWKS_TTL_MS = 10 * 60_000
export const JWKS_REFETCH_MIN_MS = 30_000
export const CLOCK_SKEW_SECONDS = 60
const JWKS_TIMEOUT_MS = 5_000
const MAX_TOKEN_LENGTH = 16 * 1024

export type AccessVerdict =
  | { ok: true; email: string }
  | { ok: false; code: "unauthorized" | "forbidden" | "unavailable"; reason: string }

export interface AccessConfig {
  teamDomain: string
  audience: string
  admins: Set<string>
}

/** Null when any required value is missing or malformed. */
export function accessConfig(env: Env): AccessConfig | null {
  const rawDomain = env.ACCESS_TEAM_DOMAIN?.trim()
  const audience = env.ACCESS_AUD?.trim()
  const admins = new Set(
    (env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0)
  )
  if (!rawDomain || !audience || admins.size === 0) return null
  let url: URL
  try {
    url = new URL(rawDomain)
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    return null
  if (url.pathname !== "/" && url.pathname !== "") return null
  return { teamDomain: url.origin, audience, admins }
}

interface CachedKeys {
  keys: Map<string, CryptoKey>
  fetchedAtMs: number
  lastAttemptMs: number
}

const keyCache = new Map<string, CachedKeys>()

/** Tests reset the in-memory JWKS cache between cases. */
export function resetAccessKeyCache(): void {
  keyCache.clear()
}

interface Jwk {
  kid?: unknown
  kty?: unknown
  alg?: unknown
  n?: unknown
  e?: unknown
}

async function fetchKeys(teamDomain: string): Promise<Map<string, CryptoKey> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS)
  try {
    const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const body = (await response.json()) as { keys?: unknown }
    if (!Array.isArray(body.keys)) return null
    const keys = new Map<string, CryptoKey>()
    for (const raw of body.keys as Jwk[]) {
      if (
        typeof raw.kid !== "string" ||
        raw.kty !== "RSA" ||
        typeof raw.n !== "string" ||
        typeof raw.e !== "string"
      ) {
        continue
      }
      if (raw.alg !== undefined && raw.alg !== "RS256") continue
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: raw.n, e: raw.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"]
        )
        keys.set(raw.kid, key)
      } catch {
        // Skip a malformed key; the others stay usable.
      }
    }
    return keys
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The verification key for `kid`, refreshing the cache when allowed. */
async function keyFor(
  teamDomain: string,
  kid: string,
  nowMs: number
): Promise<CryptoKey | "unknown" | "unavailable"> {
  let cached = keyCache.get(teamDomain)
  const fresh = cached !== undefined && nowMs - cached.fetchedAtMs < JWKS_TTL_MS
  const known = cached?.keys.get(kid)
  if (known && fresh) return known
  const mayFetch =
    cached === undefined || !fresh || nowMs - cached.lastAttemptMs >= JWKS_REFETCH_MIN_MS
  if (mayFetch) {
    const fetched = await fetchKeys(teamDomain)
    if (fetched) {
      cached = { keys: fetched, fetchedAtMs: nowMs, lastAttemptMs: nowMs }
    } else if (cached) {
      cached = { ...cached, lastAttemptMs: nowMs }
    } else {
      keyCache.set(teamDomain, { keys: new Map(), fetchedAtMs: 0, lastAttemptMs: nowMs })
      return "unavailable"
    }
    keyCache.set(teamDomain, cached)
  }
  return cached?.keys.get(kid) ?? "unknown"
}

function decodeJson(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(segment)
  if (!bytes) return null
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
    )
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function readAccessToken(request: Request): string | null {
  const header = request.headers.get("cf-access-jwt-assertion")?.trim()
  if (header) return header
  const cookie = request.headers.get("cookie")
  if (!cookie) return null
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name === "CF_Authorization" && rest.length > 0) return rest.join("=").trim() || null
  }
  return null
}

function deny(code: "unauthorized" | "forbidden" | "unavailable", reason: string): AccessVerdict {
  return { ok: false, code, reason }
}

export async function verifyAccess(
  request: Request,
  env: Env,
  nowMs: number
): Promise<AccessVerdict> {
  const config = accessConfig(env)
  if (!config) return deny("unavailable", "access_not_configured")
  const token = readAccessToken(request)
  if (!token) return deny("unauthorized", "missing_token")
  if (token.length > MAX_TOKEN_LENGTH) return deny("unauthorized", "malformed_token")
  const parts = token.split(".")
  if (parts.length !== 3) return deny("unauthorized", "malformed_token")
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
  const header = decodeJson(headerPart)
  const payload = decodeJson(payloadPart)
  const signature = base64UrlToBytes(signaturePart)
  if (!header || !payload || !signature) return deny("unauthorized", "malformed_token")
  if (header.alg !== "RS256" || typeof header.kid !== "string")
    return deny("unauthorized", "unsupported_alg")

  const key = await keyFor(config.teamDomain, header.kid, nowMs)
  if (key === "unavailable") return deny("unavailable", "jwks_unavailable")
  if (key === "unknown") return deny("unauthorized", "unknown_kid")
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`)
  const signatureBuffer = new Uint8Array(new ArrayBuffer(signature.byteLength))
  signatureBuffer.set(signature)
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signatureBuffer, signed)
  if (!valid) return deny("unauthorized", "bad_signature")

  if (payload.iss !== config.teamDomain) return deny("unauthorized", "wrong_issuer")
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audiences.includes(config.audience)) return deny("unauthorized", "wrong_audience")
  const nowSeconds = nowMs / 1000
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
    return deny("unauthorized", "expired")
  }
  if (
    payload.nbf !== undefined &&
    (typeof payload.nbf !== "number" || payload.nbf - CLOCK_SKEW_SECONDS > nowSeconds)
  ) {
    return deny("unauthorized", "not_yet_valid")
  }
  if (typeof payload.email !== "string" || payload.email.length === 0)
    return deny("forbidden", "no_email_identity")
  const email = payload.email.trim().toLowerCase()
  if (!config.admins.has(email)) return deny("forbidden", "not_allowlisted")
  return { ok: true, email }
}
