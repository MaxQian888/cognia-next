/**
 * Pending-authorization store for the Google Workspace document connection.
 *
 * Same problem, same shape, and the same reasoning as the Lark equivalent
 * (`lib/connectors/adapters/lark/oauth-pending.ts`): the authorize step and the
 * completion step run in different call stacks and can straddle an app restart,
 * so the PKCE `code_verifier`, the exact `redirect_uri`, and the `state` must
 * survive that gap — and a PKCE verifier is a secret, so it belongs in the
 * encrypted keyring rather than Web Storage.
 *
 * It uses the `docs-providers` namespace instead of a connector's own, because
 * this connection is not a connector. Single record: only one Google
 * authorization can be in flight, with a 10-minute TTL and clear-on-use so an
 * abandoned attempt leaves nothing replayable.
 */

import { googleState } from "./state"

export const GOOGLE_OAUTH_PENDING_KEY = "google-oauth-pending"

export const GOOGLE_OAUTH_PENDING_TTL_MS = 10 * 60 * 1000

export interface GoogleOAuthPending {
  /** The `google:<nonce>` state echoed back on the redirect. */
  state: string
  /** PKCE verifier whose challenge was sent to the authorize endpoint. */
  codeVerifier: string
  /** The exact redirect_uri sent to authorize — must be replayed at exchange. */
  redirectUri: string
  /** Wall-clock ms the record was written (for TTL expiry). */
  ts: number
}

export async function setGoogleOAuthPending(
  pending: Omit<GoogleOAuthPending, "ts">,
  now = Date.now(),
  authorization?: string
): Promise<void> {
  const owner = authorization ?? (await googleState({ action: "begin" })).state.authorization
  await googleState({
    action: "setPending",
    authorization: owner,
    pending: { ...pending, ts: now },
  })
}

/** Host state is canonical; the old key is read only during native migration. */
export async function getGoogleOAuthPending(now = Date.now()): Promise<GoogleOAuthPending | null> {
  const pending = (await googleState({ action: "snapshot" })).state.pending
  return pending && now - pending.ts <= GOOGLE_OAUTH_PENDING_TTL_MS ? pending : null
}

export async function clearGoogleOAuthPending(): Promise<void> {
  await googleState({ action: "begin" })
}
