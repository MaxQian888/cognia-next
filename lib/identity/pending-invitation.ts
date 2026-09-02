/**
 * An invitation token that arrived before the person could redeem it.
 *
 * `/invite?token=…` is reachable while nobody is signed in. The token is kept
 * in sessionStorage, never localStorage: it is a credential, it is one-time,
 * and it should not outlive the tab it was pasted into. The sign-in gate
 * redeems it the moment there is a session to redeem it with.
 */

export const PENDING_INVITATION_KEY = "cognia.invitation.pending"

/** URL-safe base64 of 32 bytes is 43 characters. Some slack either way. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/

export interface PendingInvitationStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function store(explicit?: PendingInvitationStore): PendingInvitationStore | null {
  if (explicit) return explicit
  if (typeof sessionStorage === "undefined") return null
  return sessionStorage
}

export function isInvitationTokenShaped(value: string): boolean {
  return TOKEN_SHAPE.test(value.trim())
}

/** Keep the token for the gate. Returns false when the value is not a token. */
export function rememberPendingInvitation(
  token: string,
  explicit?: PendingInvitationStore
): boolean {
  const trimmed = token.trim()
  if (!isInvitationTokenShaped(trimmed)) return false
  store(explicit)?.setItem(PENDING_INVITATION_KEY, trimmed)
  return true
}

export function readPendingInvitation(explicit?: PendingInvitationStore): string | null {
  const value = store(explicit)?.getItem(PENDING_INVITATION_KEY) ?? null
  if (value && !isInvitationTokenShaped(value)) {
    store(explicit)?.removeItem(PENDING_INVITATION_KEY)
    return null
  }
  return value
}

export function clearPendingInvitation(explicit?: PendingInvitationStore): void {
  store(explicit)?.removeItem(PENDING_INVITATION_KEY)
}
