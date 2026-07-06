// Resolve the provider for the standalone (BYOK) chat path from local settings.
//
// Shared by the credential probe (`use-credential-status`) and the standalone
// chat engine so the "which provider + key do we use on the phone?" decision
// lives in exactly one place. Reuses the same `createProviderSettingsSnapshot` +
// `resolveFeatureProvider` pipeline the sidecar build-options path uses — the
// settings store is the single source of truth for BYOK keys on mobile.

import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  type ProviderResolution,
  type ProviderSettingsEntry,
  type RichCustomProviderEntry,
} from "@/lib/ai/provider-consumption"
import type { AppSettings } from "@/lib/claude/types"

type ProviderSettingsSlice = Pick<
  AppSettings,
  "defaultProvider" | "providerSettings" | "customProviders"
>

/**
 * Resolve the best provider for standalone chat from the app settings. Prefers
 * the configured default provider, otherwise the first eligible one. Returns a
 * `ProviderResolution` — `.kind === "resolved"` means a usable provider+key
 * exists; `"unresolved"` carries a `nextAction` hint for the UI.
 */
export function resolveStandaloneProvider(
  settings: ProviderSettingsSlice | null | undefined
): ProviderResolution {
  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: settings?.defaultProvider,
    providerSettings: settings?.providerSettings as
      | Record<string, ProviderSettingsEntry>
      | undefined,
    customProviders: settings?.customProviders as RichCustomProviderEntry[] | undefined,
  })
  return resolveFeatureProvider(
    {
      featureId: "standalone-chat",
      routeProfile: "general-text",
      selectionMode: snapshot.defaultProvider ? "explicit-provider" : "any",
      providerId: snapshot.defaultProvider,
      fallbackMode: "first-eligible",
    },
    snapshot
  )
}
