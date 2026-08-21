/**
 * Pending-authorization store for the Slack OAuth v2 flow.
 *
 * Mirrors `adapters/lark/oauth-pending.ts`, and for the same reason: the
 * authorize step and the completion step run in different call stacks and,
 * because the relay bounces through a browser, potentially across a restart.
 * The `state` for a durable CSRF check and the exact `redirect_uri` sent to
 * authorize both have to survive that gap and reach `handleSlackOAuth`.
 *
 * Both halves run **in the brain** (ADR-0059 host parity): on the desktop the
 * brain is the WebView, on a self-hosted install it is the `cognia-agent serve`
 * process. That is why this is not `sessionStorage` — the headless brain's Web
 * Storage is an in-memory shim, and the browser that opened the settings dialog
 * is a different process entirely, so a state written there was never visible
 * to the process that had to spend it. The renderer's `sessionStorage` copy
 * (`CONNECTOR_OAUTH_STATE_KEY`) stays a desktop-only pre-check; THIS record is
 * the authoritative one.
 *
 * No PKCE: Slack's `oauth.v2.access` authenticates the app with
 * `client_secret`, which never leaves the brain, so there is no verifier to
 * park here.
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
 * Deliberately NOT mirrored into `AdapterInstanceRow.credentialsRef.accounts`:
 * that list is a durable index of what an adapter owns, and this entry is gone
 * within ten minutes.
 */
export const SLACK_OAUTH_PENDING_CREDENTIAL = "oauth_pending"

const TTL_MS = 10 * 60 * 1000

export interface SlackOAuthPending {
  /** The `slack:<adapterId>:<nonce>` state echoed back on the redirect. */
  state: string
  /** The exact redirect_uri sent to authorize — must be replayed at exchange. */
  redirectUri: string
  /** Wall-clock ms the record was written (for TTL expiry). */
  ts: number
}

/** Persist a pending authorization for `adapterId`. Stamps `ts` = now. */
export async function setSlackOAuthPending(
  adapterId: string,
  pending: Omit<SlackOAuthPending, "ts">,
  now = Date.now()
): Promise<void> {
  const record: SlackOAuthPending = { ...pending, ts: now }
  await connectorsKeyringSet(adapterId, SLACK_OAUTH_PENDING_CREDENTIAL, JSON.stringify(record))
}

/**
 * Read the pending authorization for `adapterId`. Returns null when absent,
 * malformed, or older than the TTL (an expired record is also evicted).
 */
export async function getSlackOAuthPending(
  adapterId: string,
  now = Date.now()
): Promise<SlackOAuthPending | null> {
  let raw: string | null
  try {
    raw = await connectorsKeyringGet(adapterId, SLACK_OAUTH_PENDING_CREDENTIAL)
  } catch {
    // Store unavailable (locked, or no host) — indistinguishable from absent
    // for this caller, and the exchange reports "retry Connect" either way.
    return null
  }
  if (!raw) return null
  let record: SlackOAuthPending
  try {
    record = JSON.parse(raw) as SlackOAuthPending
  } catch {
    return null
  }
  if (
    !record ||
    typeof record.ts !== "number" ||
    typeof record.state !== "string" ||
    typeof record.redirectUri !== "string"
  ) {
    return null
  }
  if (now - record.ts > TTL_MS) {
    await clearSlackOAuthPending(adapterId)
    return null
  }
  return record
}

/** Remove any pending authorization for `adapterId` (clear-on-use). */
export async function clearSlackOAuthPending(adapterId: string): Promise<void> {
  try {
    await connectorsKeyringDelete(adapterId, SLACK_OAUTH_PENDING_CREDENTIAL)
  } catch {
    // Delete is idempotent and best-effort; the TTL is the backstop.
  }
}
