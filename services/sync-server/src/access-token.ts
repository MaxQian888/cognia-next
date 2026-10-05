/**
 * The bearer access token (protocol §5.6): issued by this environment's
 * issuer for the sync API (`aud`), an RFC 9068 `at+jwt`, ES256, to one of the
 * first-party Cognia clients, for a person (`usr_` subject).
 */

import { createLocalJWKSet, errors, jwtVerify } from "jose"

import { SyncHttpError } from "./http"
import type { JwksCache } from "./jwks"

/** The Cognia apps as OAuth clients (services/identity-server/src/first-party-clients.ts). */
export const FIRST_PARTY_CLIENT_IDS: readonly string[] = ["cognia-app", "cognia-web"]

const USER_ID = /^usr_[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? ""
  const match = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim())
  return match ? match[1]! : null
}

export interface TokenCheck {
  jwks: JwksCache
  issuer: string
  audience: string
  now?: () => number
}

async function verifyOnce(token: string, check: TokenCheck) {
  return jwtVerify(token, createLocalJWKSet(await check.jwks.get()), {
    issuer: check.issuer,
    audience: check.audience,
    typ: "at+jwt",
    algorithms: ["ES256"],
    ...(check.now ? { currentDate: new Date(check.now()) } : {}),
  })
}

/** Returns the person's `usr_` id, or throws a 401. */
export async function verifyAccessToken(token: string, check: TokenCheck): Promise<string> {
  let payload
  try {
    try {
      ;({ payload } = await verifyOnce(token, check))
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey) || !(await check.jwks.refresh())) throw error
      ;({ payload } = await verifyOnce(token, check))
    }
  } catch {
    throw new SyncHttpError(401, "unauthorized", "the access token is invalid")
  }
  const client = typeof payload.client_id === "string" ? payload.client_id : payload.azp
  if (typeof client !== "string" || !FIRST_PARTY_CLIENT_IDS.includes(client)) {
    throw new SyncHttpError(401, "unauthorized", "the access token was not issued to a Cognia app")
  }
  if (typeof payload.sub !== "string" || !USER_ID.test(payload.sub)) {
    throw new SyncHttpError(401, "unauthorized", "the access token has no person subject")
  }
  return payload.sub
}
