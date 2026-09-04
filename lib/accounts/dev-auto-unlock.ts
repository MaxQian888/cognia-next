/**
 * E2E-artifact-only bypass of the local account password prompt.
 *
 * In production the account lock is intentionally in-memory only: every launch
 * — and every reload — resets `unlockedAccountId` to null, so the AccountGate
 * asks for the password again. During local development (`pnpm dev` /
 * `pnpm tauri dev`) the webview restarts constantly (Rust rebuilds, HMR, manual
 * refreshes). Ordinary development builds must still exercise the real
 * password path because it activates the Browser Vault and native plugin
 * account session together.
 *
 * Scope is deliberately narrow:
 *  - Enabled only in a dedicated `NEXT_PUBLIC_E2E=1` static browser artifact.
 *    Shipped desktop/mobile builds do not set that flag.
 *  - Disabled server-side; the gate only exists inside a webview.
 *  - `NEXT_PUBLIC_ACCOUNT_GATE=1` forces the real unlock flow in that artifact.
 *  - Only unlocks an account that ALREADY exists. First-run account creation
 *    still asks for a password: the account id scopes the Dexie database
 *    (`cognia-account-<id>`), so it must stay a deliberate choice.
 *  - The caller provisions/unlocks a disposable Browser Vault before reporting
 *    the account unlocked. It never runs in Tauri, where native reauthentication
 *    is part of the security boundary.
 *  - Locking at runtime (`lock()`, idle auto-lock) still locks. Only the boot
 *    path is relaxed, so the gate itself stays reachable in dev.
 */

/** Env var that forces the real password gate back on in a dev build. */
export const FORCE_ACCOUNT_GATE_ENV = "NEXT_PUBLIC_ACCOUNT_GATE"

/**
 * True only for the dedicated browser E2E artifact.
 */
export function isDevAutoUnlockEnabled(): boolean {
  if (typeof window === "undefined") return false
  // Written out literally so Next's build-time env inlining can see it.
  if (process.env.NEXT_PUBLIC_ACCOUNT_GATE === "1") return false
  return process.env.NEXT_PUBLIC_E2E === "1"
}

/**
 * ---------------------------------------------------------------------------
 * Development server: the disposable local account.
 * ---------------------------------------------------------------------------
 *
 * The auto-unlock above only ever re-opens an account that ALREADY exists,
 * which is right for the E2E artifact (its fixture seeds the registry first)
 * and useless for `pnpm dev`. Every fresh browser profile, whether a private
 * window, a new agent/Playwright context, or a cleared origin, starts with an
 * empty IndexedDB, so the gate falls through to first-run setup: type a
 * display name, type a password, submit, copy the recovery key, tick the
 * checkbox, continue. Six interactions before the app paints, repeated on
 * every browser that touches the dev server, and each one mints a *different*
 * account id, so the previous profile's Dexie database
 * (`cognia-account-<id>`) is orphaned rather than reused.
 *
 * A development browser build therefore provisions one deterministic account
 * instead. The fixed id is the point: every profile on this origin lands back
 * in the same database.
 *
 * The scope line is exactly the one {@link isDevAutoUnlockEnabled} draws, and
 * for the same reasons.
 *
 *  - `NODE_ENV === "production"` disables it. That is what `pnpm build` sets
 *    for the static export the desktop and mobile shells consume, so no
 *    shipped artifact can carry it.
 *  - Never under Tauri. There the account password binds the OS keyring, and a
 *    hardcoded one would put a keyring-unlocking secret in the bundle. The
 *    caller enforces that, see `stores/account/account-store.ts`.
 *  - `NEXT_PUBLIC_ACCOUNT_GATE=1` forces the real create/unlock flow back on,
 *    so first-run setup and the lock screen stay reachable in a dev build.
 *  - Only the *absence* of accounts triggers provisioning, and only this
 *    account id is auto-unlocked. A developer who creates their own account by
 *    hand keeps the real password prompt.
 */

/** Fixed id of the development account, so a fresh profile reuses one database. */
export const DEV_LOCAL_ACCOUNT_ID = "acct_dev_local_workspace"

/**
 * Fixed password of the development account.
 *
 * Not a secret and not treated as one. It only ever opens a Browser Vault this
 * same module provisioned, in a build that cannot ship.
 */
export const DEV_LOCAL_ACCOUNT_PASSWORD = "cognia-dev-local-account"

/** Display name of the development account. */
export const DEV_LOCAL_ACCOUNT_DISPLAY_NAME = "Developer"

/**
 * True while `next dev` is serving this page and the disposable account may be
 * provisioned and opened without a prompt.
 *
 * Matched against `"development"` rather than negated against `"production"`
 * so the branch is off under `NODE_ENV=test` as well. A Jest suite that flips
 * a platform mock to the browser must not start auto-creating accounts behind
 * whatever it was actually asserting.
 *
 * Written against `process.env` literals so Next's build-time inlining can
 * fold the branch away. A computed lookup would leave it in the bundle.
 */
export function isDevLocalAccountEnabled(): boolean {
  if (typeof window === "undefined") return false
  if (process.env.NEXT_PUBLIC_ACCOUNT_GATE === "1") return false
  return process.env.NODE_ENV === "development"
}

/**
 * Is this the auto-provisioned development account?
 *
 * Consumers use it to relax first-run surfaces for this account only, rather
 * than for development at large. See `components/providers/onboarding-gate.tsx`.
 */
export function isDevLocalAccount(accountId: string | null | undefined): boolean {
  if (!accountId) return false
  if (!isDevLocalAccountEnabled()) return false
  return accountId === DEV_LOCAL_ACCOUNT_ID
}
