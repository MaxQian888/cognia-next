/**
 * Who is calling the account API, proven by tokens this issuer signed.
 *
 * - Every call carries a bearer **access token** for the sync API: the issuer,
 *   the audience and `typ: at+jwt` (RFC 9068) are checked, so an ID token or a
 *   token from another issuer cannot stand in.
 * - Asking for deletion additionally needs a **fresh ID token** for the same
 *   person, issued to a first-party client, whose `auth_time` is at most
 *   `FRESH_AUTH_SECONDS` old: the person signed in again just now, so a stolen
 *   long-lived refresh token alone cannot delete an account.
 */

import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose"

import { FIRST_PARTY_CLIENT_IDS } from "../first-party-clients"

export const FRESH_AUTH_SECONDS = 10 * 60

const USER_ID = /^usr_[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/

export class AccountTokenError extends Error {
  readonly status: 401 | 403
  constructor(status: 401 | 403, message: string) {
    super(message)
    this.name = "AccountTokenError"
    this.status = status
  }
}

export interface TokenVerifierInput {
  jwks: JSONWebKeySet
  issuer: string
  audience: string
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? ""
  const match = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim())
  return match ? match[1]! : null
}

/** Verify a sync-API access token and return its `usr_` subject. */
export async function verifyAccessToken(token: string, input: TokenVerifierInput): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet(input.jwks), {
      issuer: input.issuer,
      audience: input.audience,
      typ: "at+jwt",
      algorithms: ["ES256"],
    })
    if (typeof payload.sub !== "string" || !USER_ID.test(payload.sub)) {
      throw new AccountTokenError(401, "access token has no person subject")
    }
    return payload.sub
  } catch (error) {
    if (error instanceof AccountTokenError) throw error
    throw new AccountTokenError(401, "access token is invalid")
  }
}

/** Verify that `idToken` proves a sign-in by `userId` within the last few minutes. */
export async function verifyFreshIdToken(
  idToken: string,
  userId: string,
  input: Omit<TokenVerifierInput, "audience">,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<void> {
  let payload
  try {
    ;({ payload } = await jwtVerify(idToken, createLocalJWKSet(input.jwks), {
      issuer: input.issuer,
      audience: [...FIRST_PARTY_CLIENT_IDS],
      algorithms: ["ES256"],
      currentDate: new Date(nowSeconds * 1000),
    }))
  } catch {
    throw new AccountTokenError(401, "id token is invalid")
  }
  if (payload.sub !== userId) throw new AccountTokenError(403, "id token belongs to someone else")
  const authTime = payload.auth_time
  if (typeof authTime !== "number" || nowSeconds - authTime > FRESH_AUTH_SECONDS) {
    throw new AccountTokenError(403, "a fresh sign-in is required")
  }
}
