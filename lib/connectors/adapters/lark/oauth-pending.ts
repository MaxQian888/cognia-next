/**
 * Pending-authorization store for the Lark send-as-user OAuth flow.
 *
 * The authorize step and the completion step run in different call stacks and,
 * with the relay redirect, potentially across a restart. The PKCE
 * `code_verifier`, the exact `redirect_uri` used at authorize time, and the
 * `state` for a durable CSRF check must survive that gap and reach
 * `handleLarkOAuth`.
 *
 * Both halves run **in the brain** (ADR-0059 host parity): on the desktop the
 * brain is the WebView, on a self-hosted install it is the `cognia-agent serve`
 * process. That is why this is no longer `localStorage` — the headless brain's
 * Web Storage is an in-memory shim (`lib/headless/node-indexeddb.ts`, "the
 * brain's durable state is Dexie"), and the browser that opened the settings
 * dialog is a different process entirely, so a verifier written there was
 * never visible to the process that had to spend it.
 *
 * It lives in the connectors secret store instead: the same
 * `cognia_secrets::secret_store` that already holds this adapter's `appId`,
 * `appSecret` and `user_token`. A PKCE verifier IS a secret, the store is
 * durable and encrypted on both hosts, and it needs no schema version.
 *
 * Keyed by `adapterId` (one authorization in flight per adapter), with a
 * 10-minute TTL and a clear-on-use contract so a completed or abandoned
 * authorization leaves no replayable residue.
 */

import {
  connectorsKeyringDelete,
  connectorsKeyringGet,
  connectorsKeyringSet,
} from "@/lib/connectors/tauri/commands"

/**
 * Credential name inside the adapter's secret-store namespace.
 *
 * Deliberately NOT mirrored into `AdapterInstanceRow.credentialsRef.accounts`
 * the way `user_token` is: that list is a durable index of what an adapter
 * owns, and this entry is gone within ten minutes.
 */
export const OAUTH_PENDING_CREDENTIAL = "oauth_pending"

const TTL_MS = 10 * 60 * 1000

export interface LarkOAuthPending {
  /** The `lark:<adapterId>:<nonce>` state echoed back on the redirect. */
  state: string
  /** PKCE verifier whose challenge was sent to the authorize endpoint. */
  codeVerifier: string
  /** The exact redirect_uri sent to authorize — must be replayed at exchange. */
  redirectUri: string
  /** Wall-clock ms the record was written (for TTL expiry). */
  ts: number
}

/** Persist a pending authorization for `adapterId`. Stamps `ts` = now. */
export async function setLarkOAuthPending(
  adapterId: string,
  pending: Omit<LarkOAuthPending, "ts">,
  now = Date.now()
): Promise<void> {
  const record: LarkOAuthPending = { ...pending, ts: now }
  await connectorsKeyringSet(adapterId, OAUTH_PENDING_CREDENTIAL, JSON.stringify(record))
}

/**
 * Read the pending authorization for `adapterId`. Returns null when absent,
 * malformed, or older than the TTL (an expired record is also evicted).
 */
export async function getLarkOAuthPending(
  adapterId: string,
  now = Date.now()
): Promise<LarkOAuthPending | null> {
  let raw: string | null
  try {
    raw = await connectorsKeyringGet(adapterId, OAUTH_PENDING_CREDENTIAL)
  } catch {
    // Store unavailable (locked, or no host) — indistinguishable from absent
    // for this caller, and the exchange reports "retry Connect" either way.
    return null
  }
  if (!raw) return null
  let record: LarkOAuthPending
  try {
    record = JSON.parse(raw) as LarkOAuthPending
  } catch {
    return null
  }
  if (
    !record ||
    typeof record.ts !== "number" ||
    typeof record.state !== "string" ||
    typeof record.codeVerifier !== "string" ||
    typeof record.redirectUri !== "string"
  ) {
    return null
  }
  if (now - record.ts > TTL_MS) {
    await clearLarkOAuthPending(adapterId)
    return null
  }
  return record
}

/** Remove any pending authorization for `adapterId` (clear-on-use). */
export async function clearLarkOAuthPending(adapterId: string): Promise<void> {
  try {
    await connectorsKeyringDelete(adapterId, OAUTH_PENDING_CREDENTIAL)
  } catch {
    // Delete is idempotent and best-effort; the TTL is the backstop.
  }
}
