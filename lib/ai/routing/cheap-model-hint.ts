/**
 * The cheap lane, resolved from live settings.
 *
 * Bridges the pure `resolveCheapTier` (which takes settings as arguments) to
 * the two run controllers that need it, one of which is constructed
 * synchronously and so cannot await the Dexie-backed catalog. Reading the
 * settings store at downshift time is deliberate: the answer depends on which
 * providers the user has enabled and which routing aliases exist, and a run
 * that started an hour ago should not be spending against a snapshot of that.
 *
 * The catalog-derived branch is left unfed here on purpose. Feeding it means an
 * async catalog read, and the alias branch already covers the case that
 * matters — a user who configured a `fast` alias gets it. Without an alias the
 * answer is `undefined`, which is exactly today's behaviour rather than a
 * guess at a model the account may not be able to call.
 */

import { cheapTierModelHint, resolveCheapTier } from "@cognia/provider-routing/cheap-tier"

import { useSettingsStore } from "@/stores/settings"

export function cheapModelHintFromSettings(preferProviderId?: string): string | undefined {
  const settings = useSettingsStore.getState().settings
  if (!settings) return undefined
  return cheapTierModelHint(
    resolveCheapTier({
      modelMappings: settings.modelMappings,
      providerSettings: settings.providerSettings,
      customProviders: settings.customProviders,
      ...(preferProviderId ? { preferProviderId } : {}),
    })
  )
}
