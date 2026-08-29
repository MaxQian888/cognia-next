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
