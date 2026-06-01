/**
 * Applies persisted plugin-policy settings to the live runtime.
 *
 * The persisted shape lives in localStorage under
 * `cognia.plugins.policy` (see `stores/plugin/plugin-store.ts` and
 * `components/settings/sections/plugins-section.tsx`). Three subsystems
 * consume the policy:
 *
 *   - governance mode      → PluginManager.setPluginPointGovernanceMode
 *   - signatureRequired    → PluginSignatureVerifier.setConfig
 *   - autoUpdate           → PluginUpdater.configureAutoUpdate
 *
 * Callers should apply the policy at two points:
 *
 *   1. App boot — `stores/plugin/plugin-store.ts` hydrates the persisted
 *      values into the runtime alongside `resolvePluginPointGovernanceMode()`.
 *   2. User toggle — the Settings → Plugins → Policy panel re-applies
 *      after each switch flip so the change takes effect without a reload.
 *
 * Keeping both call sites going through this single helper guarantees
 * they stay in lockstep — diverging behavior between boot-time and
 * runtime-toggle was the original wiring bug this helper closes.
 */

import { getPluginManager } from "@/lib/plugin/core/manager"
import { getPluginSignatureVerifier } from "@/lib/plugin/security/signature"
import { getPluginUpdater } from "@/lib/plugin/lifecycle/updater"
import type { PluginPointGovernanceMode } from "@/lib/plugin/contracts/plugin-points"

export interface PluginPolicySnapshot {
  governance: PluginPointGovernanceMode
  signatureRequired: boolean
  /**
   * When true, a valid signature is only accepted from a trusted publisher
   * (the official build-time-injected key + user-added publishers). Unsigned
   * or unknown-signer plugins are rejected. Optional for back-compat; defaults
   * to `false` (any valid signature passes, unknown signers warn).
   */
  trustedPublishersOnly?: boolean
  autoUpdate: boolean
}

/** Default autoUpdate cadence: check every 24 hours, notify only (the
 * user must explicitly approve the install). Mirrors what the Policy tab
 * promises in its description text. */
const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Push the policy snapshot into the three runtime singletons. Safe to call
 * during SSR (the manager/verifier/updater singletons are lazily created
 * and the call is a no-op when they haven't been instantiated yet — but in
 * practice this is invoked only inside client components / store boot
 * paths that have already produced those singletons).
 */
export function applyPluginPolicyToRuntime(policy: PluginPolicySnapshot): void {
  // 1. Governance mode.
  try {
    getPluginManager().setPluginPointGovernanceMode(policy.governance)
  } catch {
    // Manager hasn't booted yet (e.g. very first render before the store
    // initialize() call). Re-application on next toggle covers this.
  }

  // 2. Signature requirement.
  try {
    getPluginSignatureVerifier().setConfig({
      requireSignatures: policy.signatureRequired,
      // `trustedPublishersOnly` rejects unknown signers; `allowUntrusted` is
      // its inverse on the "valid signature, untrusted signer" path, so keep
      // them consistent.
      trustedPublishersOnly: policy.trustedPublishersOnly ?? false,
      allowUntrusted: !(policy.trustedPublishersOnly ?? false),
    })
  } catch {
    // Verifier hasn't been seeded yet.
  }

  // 3. Auto-update scheduler. `configureAutoUpdate` clears any prior
  // interval when `enabled` is false, so a toggle off properly stops the
  // background check.
  try {
    getPluginUpdater().configureAutoUpdate({
      enabled: policy.autoUpdate,
      checkInterval: AUTO_UPDATE_CHECK_INTERVAL_MS,
      autoInstall: false,
      notifyOnly: true,
      excludePlugins: [],
      allowPrerelease: false,
    })
  } catch {
    // Updater hasn't been seeded yet.
  }
}
