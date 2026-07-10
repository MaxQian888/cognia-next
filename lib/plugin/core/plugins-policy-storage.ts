// Persisted plugin-policy storage (localStorage `cognia.plugins.policy`).
//
// Extracted from the former Settings → Plugins → Policy tab so the policy
// shape, defaults, and read/write helpers have a single home shared by:
//   - the runtime bootstrap (`stores/plugin/plugin-store.ts`) that applies
//     the policy via `applyPluginPolicyToRuntime`, and
//   - the Plugins workspace Governance → Policy view
//     (`components/plugins/governance/plugin-governance-policy-tab.tsx`).
//
// `pluginSecurityPosture` (strict/balanced) lives separately in the settings
// store (Dexie); only the four governance/signature/update flags live here.

import type { PluginPointGovernanceMode } from "@/lib/plugin/contracts/plugin-points"
import type { PluginSource } from "@/types/plugin"

export const POLICY_STORAGE_KEY = "cognia.plugins.policy"

export interface PluginsPolicy {
  governance: PluginPointGovernanceMode
  signatureRequired: boolean
  trustedPublishersOnly: boolean
  autoUpdate: boolean
  /**
   * Per-plugin user grants for the frontend trust boundary (ADR 0013):
   * `frontend`/`hybrid` plugins from a source that is not inherently trusted
   * (see `isInherentlyTrustedFrontendSource`) are refused at load unless
   * their id is in this list.
   */
  trustedFrontendPlugins: string[]
}

/**
 * Whether a plugin source is trusted by construction for renderer-JS
 * execution: `builtin` plugins are statically bundled into the app and `dev`
 * plugins are the developer's own working tree. Everything else
 * (`local`/`marketplace`/`git`) ships third-party code and needs an explicit
 * per-plugin grant in `trustedFrontendPlugins`.
 */
export function isInherentlyTrustedFrontendSource(source: PluginSource): boolean {
  return source === "builtin" || source === "dev"
}

// ADR 0016 P0-3 (2026-05-17) — `signatureRequired` is default-on. Toggle
// stays user-overridable; the policy panel writes the explicit choice into
// localStorage so users who opted out keep that preference.
export const DEFAULT_POLICY: PluginsPolicy = {
  governance: "warn",
  signatureRequired: true,
  // Default off for back-compat: requiring a *trusted* signer is stricter than
  // requiring any valid signature, and only becomes meaningful once an official
  // publisher key is configured at build time.
  trustedPublishersOnly: false,
  autoUpdate: false,
  trustedFrontendPlugins: [],
}

export function readPolicy(): PluginsPolicy {
  if (typeof window === "undefined") return DEFAULT_POLICY
  try {
    const raw = window.localStorage.getItem(POLICY_STORAGE_KEY)
    if (!raw) return DEFAULT_POLICY
    const parsed = JSON.parse(raw)
    return {
      governance: parsed.governance === "block" ? "block" : "warn",
      // Only respect an explicit `false`; missing/undefined keeps the new
      // default-on behavior so users upgrading without ever opening Settings
      // still get strict enforcement.
      signatureRequired:
        typeof parsed.signatureRequired === "boolean" ? parsed.signatureRequired : true,
      trustedPublishersOnly: !!parsed.trustedPublishersOnly,
      autoUpdate: !!parsed.autoUpdate,
      trustedFrontendPlugins: Array.isArray(parsed.trustedFrontendPlugins)
        ? parsed.trustedFrontendPlugins.filter(
            (id: unknown): id is string => typeof id === "string"
          )
        : [],
    }
  } catch {
    return DEFAULT_POLICY
  }
}

export function writePolicy(policy: PluginsPolicy): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify(policy))
  } catch {
    // ignore quota errors
  }
}
