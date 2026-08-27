/**
 * Access-token acquisition and the authorization header pair.
 *
 * The Host's device access tokens live five minutes and are signed with a
 * key that is regenerated on every process start, so they are worth caching
 * for exactly as long as they are valid and worth persisting for zero seconds.
 * This module keeps them in memory only, which is also what makes it safe for
 * a browser extension: nothing token-shaped ever reaches `chrome.storage`.
 */
import { base64UrlToText } from "./base64url"
import { createDeviceProof } from "./dpop"
import type { DeviceSigner } from "./device-signer"
import { expectCompanionJson } from "./errors"

/** Refresh this far before expiry, so a proof cannot be minted for a dead token. */
const REFRESH_MARGIN_MS = 30_000

/** The `fetch` this client uses. Injected so callers can pin, proxy, or stub. */
export type CompanionFetch = (input: string, init: RequestInit) => Promise<Response>

export interface CompanionSessionOptions {
  /** Origin only, no trailing slash required. */
  baseUrl: string
  tenantId: string
  signer: DeviceSigner
  fetchImpl?: CompanionFetch
  /** Injectable clock, in milliseconds. */
  now?: () => number
}

interface TokenState {
  accessToken: string
  jti: string
  expiresAt: number
}

export interface CompanionSession {
  /** `{ Authorization, DPoP }` for one request. */
  authorizationHeaders(method: string, path: string): Promise<Record<string, string>>
  /** Drop the cached token; the next call re-authenticates. */
  invalidate(): void
}

export function createCompanionSession({
  baseUrl,
  tenantId,
  signer,
  fetchImpl = (input, init) => fetch(input, init),
  now = () => Date.now(),
}: CompanionSessionOptions): CompanionSession {
  const origin = baseUrl.replace(/\/+$/, "")
  let token: TokenState | null = null
  // One in-flight refresh at a time. Without this, a panel that fires its
  // capability call and its first poll together mints two tokens and burns two
  // challenges, and the second proof can be verified against the first token.
  let refreshing: Promise<TokenState> | null = null

  async function requestChallenge(): Promise<{ challengeId: string; nonce: string }> {
    const body = await expectCompanionJson(
      fetchImpl(`${origin}/api/auth/device/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId }),
      })
    )
    if (typeof body.challengeId !== "string" || typeof body.nonce !== "string") {
      throw new Error("device challenge response is malformed")
    }
    return { challengeId: body.challengeId, nonce: body.nonce }
  }

  async function refresh(): Promise<TokenState> {
    const challenge = await requestChallenge()
    const proof = await createDeviceProof({
      signer,
      nonce: challenge.nonce,
      method: "POST",
      path: "/api/auth/token",
    })
    const body = await expectCompanionJson(
      fetchImpl(`${origin}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId,
          deviceId: signer.deviceId,
          challengeId: challenge.challengeId,
          challengeNonce: challenge.nonce,
          proof,
        }),
      })
    )
    if (typeof body.accessToken !== "string" || typeof body.expiresIn !== "number") {
      throw new Error("access token response is malformed")
    }
    const jti = readJwtId(body.accessToken)
    const state: TokenState = {
      accessToken: body.accessToken,
      jti,
      expiresAt: now() + body.expiresIn * 1_000,
    }
    token = state
    return state
  }

  async function currentToken(): Promise<TokenState> {
    if (token && token.expiresAt - now() >= REFRESH_MARGIN_MS) return token
    refreshing ??= refresh().finally(() => {
      refreshing = null
    })
    return refreshing
  }

  return {
    async authorizationHeaders(method, path) {
      const active = await currentToken()
      return {
        Authorization: `Bearer ${active.accessToken}`,
        DPoP: await createDeviceProof({ signer, nonce: active.jti, method, path }),
      }
    },
    invalidate() {
      token = null
    },
  }
}

/**
 * The `jti` out of an access token.
 *
 * Read, not verified: the signature is the Host's to check, and the client has
 * no key for it. All that is needed here is the identifier the next proof must
 * quote.
 */
function readJwtId(accessToken: string): string {
  const segments = accessToken.split(".")
  if (segments.length !== 3) throw new Error("access token is malformed")
  // `base64UrlToText`, not a local `atob`: `atob` yields one char per byte, so
  // any non-ASCII claim in the payload is mangled before `JSON.parse` sees it.
  // Only `jti` is read today and a UUID is ASCII, but a second hand-rolled copy
  // of the padding arithmetic is a copy that can drift from the tested one.
  const claims = JSON.parse(base64UrlToText(segments[1])) as Record<string, unknown>
  if (typeof claims.jti !== "string") throw new Error("access token is missing jti")
  return claims.jti
}
