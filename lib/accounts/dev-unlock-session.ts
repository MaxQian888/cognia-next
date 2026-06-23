/**
 * Dev-only persistence of the unlocked account across page reloads.
 *
 * In production the account lock is intentionally in-memory only: every reload
 * resets `unlockedAccountId` to null so the AccountGate re-prompts for the
 * password. During local development (`pnpm dev` / `pnpm tauri dev`) the webview
 * reloads constantly (HMR, manual refresh), and re-entering the password on
 * every reload makes debugging painful.
 *
 * To smooth that out — and ONLY in non-production builds — we remember which
 * account was unlocked in `sessionStorage`, so a reload within the same window
 * session can restore the unlocked state without another password prompt.
 *
 * Scope is deliberately narrow:
 *  - Disabled entirely when `NODE_ENV === "production"` (the shipped app).
 *  - Uses `sessionStorage`, so it never survives closing the window/app.
 *  - Stores only the account id (never the password or any secret).
 */

const STORAGE_KEY = "cognia-dev-unlocked-account"

/**
 * True only in non-production builds that have a usable `sessionStorage`.
 * The shipped desktop/mobile app reports `NODE_ENV === "production"`, so this
 * relaxation never affects real users.
 */
export function isDevUnlockPersistenceEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined"
}

/** Remember the unlocked account so the next reload can restore it (dev only). */
export function rememberDevUnlock(accountId: string): void {
  if (!isDevUnlockPersistenceEnabled()) return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, accountId)
  } catch {
    // sessionStorage can throw (private mode / quota / disabled). A failed
    // remember simply means the next reload re-prompts, which is always safe.
  }
}

/** Read the remembered unlocked account id, or null when absent/disabled. */
export function readDevUnlock(): string | null {
  if (!isDevUnlockPersistenceEnabled()) return null
  try {
    return window.sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** Drop any remembered unlock (called on lock / sign-out / stale restore). */
export function forgetDevUnlock(): void {
  if (!isDevUnlockPersistenceEnabled()) return
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing actionable — a stale entry is re-validated on the next load.
  }
}
