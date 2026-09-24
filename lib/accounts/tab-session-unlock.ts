/**
 * Development browser builds only: remember one successful unlock for the
 * lifetime of the tab.
 *
 * The account lock is deliberately in-memory (`stores/account/account-store.ts`
 * resets `unlockedAccountId` on every boot). Without this, every reload of a
 * browser tab (a refresh, an HMR full reload, a hard navigation to `/pair` or
 * `/onboarding`) asked for the password that was typed seconds earlier.
 * It is a development-only convenience, and deliberately stays one: the value
 * is the plaintext password, and browsers write `sessionStorage` to disk for
 * session restore, so in a production build it would outlive the tab (and the
 * browser restart) that is supposed to end it.
 *
 * Scope is deliberately narrow:
 *
 *  - The secret is written only AFTER the user has typed it and it has already
 *    unlocked the vault. Nothing here can open an account that was not opened
 *    by hand in this tab first.
 *  - It lives in `sessionStorage`, so it dies with the tab. A new tab or a new
 *    window asks again (a browser's session restore can bring it back, which
 *    is exactly why production builds never write it).
 *  - `lock()` erases it, and so does idle auto-lock, which goes through
 *    `lock()`. An explicit lock must really lock, otherwise the next reload
 *    would silently undo it.
 *  - `NEXT_PUBLIC_ACCOUNT_GATE=1` forces the real password flow back on, so the
 *    lock screen stays testable.
 *
 * Why remembering the password in the tab costs little: in a browser the vault
 * master key is derived in this same renderer, and script that can read this
 * tab's `sessionStorage` can equally read the unlocked vault or hook the unlock
 * form. It adds no reach that the unlocked tab did not already have.
 *
 * Deliberately NOT enabled under Tauri or Capacitor. On the desktop the
 * password binds the native host, and the right place for a remembered secret
 * is the native secret store, which is what "unlock automatically on this
 * device" uses (`lib/accounts/desktop-local-account.ts`). Capacitor keeps its
 * own runtime chooser and never shows the local lock screen.
 */

import { isAccountGateForced } from "@/lib/accounts/dev-auto-unlock"
import { isCapacitor, isTauri } from "@/lib/platform/detect"

const STORAGE_PREFIX = "cognia.tab-session-unlock."
/** Written by builds from before the rename. Swept by {@link forgetTabSessionUnlock}. */
const LEGACY_STORAGE_PREFIX = "cognia.dev-session-unlock."

/** `sessionStorage` key for one account's remembered secret. */
export function tabSessionUnlockStorageKey(localAccountId: string): string {
  return `${STORAGE_PREFIX}${localAccountId}`
}

/**
 * Is remembering an unlock allowed in this runtime?
 *
 * The desktop and mobile shells keep their own credential stores. See the
 * module docstring.
 */
export function isTabSessionUnlockEnabled(): boolean {
  if (typeof window === "undefined") return false
  if (isAccountGateForced()) return false
  // Literal comparison so the bundler drops the write path from production.
  if (process.env.NODE_ENV === "production") return false
  return !isTauri() && !isCapacitor()
}

/** Storage access is wrapped: a private window or a blocked origin throws. */
function sessionStore(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Remember a secret that has ALREADY unlocked this account in this tab. */
export function rememberTabSessionUnlock(localAccountId: string, password: string): void {
  if (!isTabSessionUnlockEnabled()) return
  if (!localAccountId || !password) return
  try {
    sessionStore()?.setItem(tabSessionUnlockStorageKey(localAccountId), password)
  } catch {
    // Quota or a hardened profile. Losing the convenience is not an error.
  }
}

/** The remembered secret for this account, or null. */
export function readTabSessionUnlock(localAccountId: string): string | null {
  if (!isTabSessionUnlockEnabled()) return null
  if (!localAccountId) return null
  try {
    const value = sessionStore()?.getItem(tabSessionUnlockStorageKey(localAccountId))
    return value && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * Forget one account's secret, or every account's when called with no id.
 *
 * The no-argument form is what `lock()` uses. It sweeps the whole prefix rather
 * than only the account being locked, because a lock is a statement about this
 * tab, and leaving a sibling account's secret behind would let the very next
 * reload re-unlock into a different account. It runs regardless of
 * {@link isTabSessionUnlockEnabled}, so a secret some earlier build wrote can
 * never outlive a lock.
 */
export function forgetTabSessionUnlock(localAccountId?: string): void {
  const store = typeof window === "undefined" ? null : sessionStore()
  if (!store) return
  try {
    if (localAccountId) {
      store.removeItem(tabSessionUnlockStorageKey(localAccountId))
      store.removeItem(`${LEGACY_STORAGE_PREFIX}${localAccountId}`)
      return
    }
    const doomed: string[] = []
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index)
      if (key?.startsWith(STORAGE_PREFIX) || key?.startsWith(LEGACY_STORAGE_PREFIX)) {
        doomed.push(key)
      }
    }
    for (const key of doomed) store.removeItem(key)
  } catch {
    // Nothing to clear if the store cannot be read.
  }
}
