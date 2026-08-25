/**
 * Unverified JWT payload decoding — claim EXTRACTION only, never trust.
 *
 * A JWT's payload is base64url-encoded, not encrypted, so anyone can read it.
 * Reading it locally is legitimate for routing and display — "which org is this
 * token for", "what is its jti" — and illegitimate for authorization. Every
 * signature check in this product happens where the token is consumed:
 * `src-tauri/src/companion_api/oidc.rs` for Logto, the Rust gateway for device
 * tokens. Nothing here proves anything.
 *
 * This module exists because the same fifteen lines had already been written
 * twice — `lib/connectors/lark-web/session.ts` and a private copy inside
 * `lib/tauri/companion-auth.ts` — with two different error behaviours. Both
 * shapes are kept, because both call sites are right about what they need:
 * a router wants `null` and a token exchange wants a throw.
 */

/** The decoded payload of a JWS. Values are whatever the issuer put there. */
export type JwtPayload = Record<string, unknown>

export class MalformedJwtError extends Error {
  constructor(message = "token is malformed") {
    super(message)
    this.name = "MalformedJwtError"
  }
}

function decodeSegment(segment: string): unknown {
  const normalized = segment.replaceAll("-", "+").replaceAll("_", "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  return JSON.parse(atob(padded)) as unknown
}

/**
 * Decode the payload, or return `null` for anything that is not a well-formed
 * three-segment JWS with a JSON object payload. Never throws.
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const decoded = decodeSegment(parts[1])
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as JwtPayload)
      : null
  } catch {
    return null
  }
}

/**
 * Decode the payload or throw. For callers that have just received a token
 * from a server and for whom an unreadable one is a protocol violation, not a
 * routing miss.
 */
export function requireJwtPayload(token: string, message?: string): JwtPayload {
  const payload = decodeJwtPayload(token)
  if (!payload) throw new MalformedJwtError(message)
  return payload
}

/** Read a claim only when it is a non-empty string; `undefined` otherwise. */
export function stringClaim(payload: JwtPayload | null, claim: string): string | undefined {
  const value = payload?.[claim]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Read a claim that is either a list of strings or a single space-delimited
 * string — OIDC spends both shapes on `scope`, `roles` and `organization_roles`
 * depending on the issuer and the grant.
 */
export function stringListClaim(payload: JwtPayload | null, claim: string): string[] {
  const value = payload?.[claim]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean)
  return []
}
