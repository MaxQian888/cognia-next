/**
 * Development-only: remember one successful unlock for the lifetime of the tab.
 *
 * The account lock is deliberately in-memory (`stores/account/account-store.ts`
 * resets `unlockedAccountId` on every boot), which is right in production and
 * unworkable while developing: Turbopack HMR remounts the app, and every
 * client-side navigation to `/pair`, `/settings` or `/onboarding` re-runs the
 * boot read, so a single debugging session re-typed the password a dozen times.
 *
 * This is the narrowest thing that fixes that:
 *
 *  - The secret is written only AFTER the user has already typed it and it has
 *    already unlocked the vault. Nothing here can unlock an account that has
 *    not been unlocked by hand first in this tab.
 *  - It lives in `sessionStorage`, so it dies with the tab. A new tab, a new
 *    window, or a restarted browser asks again.
 *  - `lock()` erases it. An explicit lock must really lock, otherwise the next
 *    boot would silently undo it.
 *  - Production builds never reach it: {@link isDevSessionUnlockEnabled} is
 *    false when `NODE_ENV === "production"`, which is what `pnpm build` sets
 *    for the static export the desktop and mobile shells consume.
 *  - `NEXT_PUBLIC_ACCOUNT_GATE=1` forces the real password flow back on, so the
 *    lock screen itself stays testable in a dev build. Same escape hatch the
 *    E2E artifact's auto-unlock already honours.
 *
 * Deliberately NOT enabled under Tauri, and that is a security judgement rather
 * than caution about scope. In a browser the vault master key is derived in the
 * renderer already, so remembering the password adds little to what that tab
 * can reach. On the desktop the same password binds the OS keyring, so caching
 * it in a webview store would put a keyring-unlocking secret somewhere the
 * keyring's threat model does not put it. `lib/accounts/dev-auto-unlock.ts`
 * draws the line in the same place for the same reason.
 */

import { isTauri } from "@/lib/platform/detect"

/** `sessionStorage` key for one account's remembered secret. */
export function devSessionUnlockStorageKey(localAccountId: string): string {
  return `cognia.dev-session-unlock.${localAccountId}`
}

/**
 * Is remembering an unlock allowed in this build?
 *
 * Written against `process.env` literals so Next's build-time inlining can see
 * them. A computed lookup would leave the branch in the production bundle.
 */
export function isDevSessionUnlockEnabled(): boolean {
  if (typeof window === "undefined") return false
  if (process.env.NEXT_PUBLIC_ACCOUNT_GATE === "1") return false
  if (process.env.NODE_ENV === "production") return false
  // The desktop shell reauthenticates natively. See the module docstring.
  // Deliberately the shared predicate rather than a second window check, so a
  // shell that starts reporting itself differently moves both at once.
  return !isTauri()
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
export function rememberDevSessionUnlock(localAccountId: string, password: string): void {
  if (!isDevSessionUnlockEnabled()) return
  if (!localAccountId || !password) return
  try {
    sessionStore()?.setItem(devSessionUnlockStorageKey(localAccountId), password)
  } catch {
    // Quota or a hardened profile. Losing the convenience is not an error.
  }
}

/** The remembered secret for this account, or null. */
export function readDevSessionUnlock(localAccountId: string): string | null {
  if (!isDevSessionUnlockEnabled()) return null
  if (!localAccountId) return null
  try {
    const value = sessionStore()?.getItem(devSessionUnlockStorageKey(localAccountId))
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
 * browser, and leaving a sibling account's secret behind would let the very
 * next boot re-unlock into a different account.
 */
export function forgetDevSessionUnlock(localAccountId?: string): void {
  const store = sessionStore()
  if (!store) return
  try {
    if (localAccountId) {
      store.removeItem(devSessionUnlockStorageKey(localAccountId))
      return
    }
    const prefix = devSessionUnlockStorageKey("")
    const doomed: string[] = []
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index)
      if (key?.startsWith(prefix)) doomed.push(key)
    }
    for (const key of doomed) store.removeItem(key)
  } catch {
    // Nothing to clear if the store cannot be read.
  }
}
