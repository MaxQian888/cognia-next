/**
 * Dev-only bypass of the local account password prompt.
 *
 * In production the account lock is intentionally in-memory only: every launch
 * — and every reload — resets `unlockedAccountId` to null, so the AccountGate
 * asks for the password again. During local development (`pnpm dev` /
 * `pnpm tauri dev`) the webview restarts constantly (Rust rebuilds, HMR, manual
 * refreshes) and re-typing the password each time is pure friction, so dev
 * builds unlock the active account at boot instead of prompting.
 *
 * Scope is deliberately narrow:
 *  - Disabled when `NODE_ENV === "production"`, except in a dedicated
 *    `NEXT_PUBLIC_E2E=1` static test artifact. Shipped desktop/mobile builds do
 *    not set that flag, so real users are never affected.
 *  - Disabled server-side; the gate only exists inside a webview.
 *  - Opt out with `NEXT_PUBLIC_ACCOUNT_GATE=1` to exercise the real unlock flow
 *    from a dev build.
 *  - Only unlocks an account that ALREADY exists. First-run account creation
 *    still asks for a password: the account id scopes the Dexie database
 *    (`cognia-account-<id>`), so it must stay a deliberate choice.
 *  - Locking at runtime (`lock()`, idle auto-lock) still locks. Only the boot
 *    path is relaxed, so the gate itself stays reachable in dev.
 */

/** Env var that forces the real password gate back on in a dev build. */
export const FORCE_ACCOUNT_GATE_ENV = "NEXT_PUBLIC_ACCOUNT_GATE"

/**
 * True when this build should unlock the active local account without a
 * password. False in production, on the server, and whenever
 * `NEXT_PUBLIC_ACCOUNT_GATE=1` asks for the real gate.
 */
export function isDevAutoUnlockEnabled(): boolean {
  if (typeof window === "undefined") return false
  // Written out literally so Next's build-time env inlining can see it.
  if (process.env.NEXT_PUBLIC_ACCOUNT_GATE === "1") return false
  if (process.env.NEXT_PUBLIC_E2E === "1") return true
  return process.env.NODE_ENV !== "production"
}
