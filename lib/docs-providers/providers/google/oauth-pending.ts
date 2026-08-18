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

import { docsProviderSecrets } from "./config"

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
  now = Date.now()
): Promise<void> {
  await docsProviderSecrets().save(
    GOOGLE_OAUTH_PENDING_KEY,
    JSON.stringify({ ...pending, ts: now } satisfies GoogleOAuthPending)
  )
}

/** Read the pending record, or null when absent, malformed, or expired. */
export async function getGoogleOAuthPending(now = Date.now()): Promise<GoogleOAuthPending | null> {
  const raw = await docsProviderSecrets().load(GOOGLE_OAUTH_PENDING_KEY)
  if (!raw) return null
  let parsed: Partial<GoogleOAuthPending>
  try {
    parsed = JSON.parse(raw) as Partial<GoogleOAuthPending>
  } catch {
    return null
  }
  if (
    typeof parsed.state !== "string" ||
    typeof parsed.codeVerifier !== "string" ||
    typeof parsed.redirectUri !== "string" ||
    typeof parsed.ts !== "number"
  ) {
    return null
  }
  if (now - parsed.ts > GOOGLE_OAUTH_PENDING_TTL_MS) return null
  return parsed as GoogleOAuthPending
}

export async function clearGoogleOAuthPending(): Promise<void> {
  await docsProviderSecrets().delete(GOOGLE_OAUTH_PENDING_KEY)
}
