/**
 * Install provenance → dispatch trust tier.
 *
 * Tier decides who wraps whom, so it must never be self-declared: a manifest
 * field naming its own tier would simply always name the highest one. It is
 * derived instead from `Plugin.source`, which only the host's install path
 * writes.
 *
 *   - `builtin`     bundled with the app and reviewed in-tree.
 *   - `marketplace` installed through the marketplace, which verifies a
 *                   detached signature by default (`requireSignatures: true`
 *                   in `lib/plugin/security/signature.ts`). Signature proves
 *                   provenance, NOT that the code is safe — which is why this
 *                   is a middle tier and not the top one.
 *   - everything else (`local`, `git`, `dev`) is community: sideloaded,
 *     cloned, or hot-reloading from a working copy.
 */

import { usePluginStore } from "@/stores/plugin-runtime"
import type { PluginSource } from "@/types/plugin"
import type { InterceptorTrustTier } from "./types"

export function trustTierForSource(source: PluginSource | undefined): InterceptorTrustTier {
  switch (source) {
    case "builtin":
      return "builtin"
    case "marketplace":
      return "verified"
    default:
      // `local`, `git`, `dev`, and anything an older record left unset. An
      // unknown provenance is the LEAST trusted answer, never a default that
      // happens to be convenient.
      return "community"
  }
}

/**
 * Tier for a plugin the store knows about.
 *
 * A plugin with no store row yet is mid-activation; it gets `community` until
 * the row lands, because the alternative — assuming the best while provenance
 * is unknown — is the assumption that costs the most when it is wrong.
 */
export function resolveInterceptorTrustTier(pluginId: string): InterceptorTrustTier {
  const row = usePluginStore.getState().plugins[pluginId]
  return trustTierForSource(row?.source)
}
