/**
 * Pending-authorization store for the Lark send-as-user OAuth flow.
 *
 * The authorize step (in the config dialog) and the completion step (in the
 * deep-link handler) run in different call stacks — and, with the relay
 * redirect, potentially across an app restart. The PKCE `code_verifier` and
 * the exact `redirect_uri` used at authorize time must survive that gap and
 * reach `handleLarkOAuth` for the token exchange, plus the `state` for a
 * durable CSRF check.
 *
 * We persist them in `localStorage` (survives an app restart, unlike
 * `sessionStorage`), keyed by `adapterId`, with a 10-minute TTL and a
 * clear-on-use contract so a completed or abandoned authorization leaves no
 * replayable residue.
 */

const PREFIX = "lark-oauth-pending:"
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

function key(adapterId: string): string {
  return `${PREFIX}${adapterId}`
}

/** Persist a pending authorization for `adapterId`. Stamps `ts` = now. */
export function setLarkOAuthPending(
  adapterId: string,
  pending: Omit<LarkOAuthPending, "ts">
): void {
  if (typeof localStorage === "undefined") return
  const record: LarkOAuthPending = { ...pending, ts: Date.now() }
  try {
    localStorage.setItem(key(adapterId), JSON.stringify(record))
  } catch {
    // Storage full / disabled — the exchange will fail with a clear error later.
  }
}

/**
 * Read the pending authorization for `adapterId`. Returns null when absent,
 * malformed, or older than the TTL (an expired record is also evicted).
 */
export function getLarkOAuthPending(adapterId: string): LarkOAuthPending | null {
  if (typeof localStorage === "undefined") return null
  const raw = localStorage.getItem(key(adapterId))
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
  if (Date.now() - record.ts > TTL_MS) {
    clearLarkOAuthPending(adapterId)
    return null
  }
  return record
}

/** Remove any pending authorization for `adapterId` (clear-on-use). */
export function clearLarkOAuthPending(adapterId: string): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.removeItem(key(adapterId))
  } catch {
    // ignore
  }
}
