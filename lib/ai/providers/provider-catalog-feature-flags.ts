export type ProviderCatalogFeatureFlag =
  "providerCatalogV2" | "dynamicLongTail" | "multimodalConsumption"

export type ProviderCatalogFeatureFlags = Record<ProviderCatalogFeatureFlag, boolean>

export const PROVIDER_CATALOG_FLAGS_STORAGE_KEY = "cognia.providerCatalog.flags"

const DEFAULT_FLAGS: ProviderCatalogFeatureFlags = {
  providerCatalogV2: true,
  dynamicLongTail: true,
  multimodalConsumption: false,
}

function storedOverrides(): Partial<ProviderCatalogFeatureFlags> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(PROVIDER_CATALOG_FLAGS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(
      (Object.keys(DEFAULT_FLAGS) as ProviderCatalogFeatureFlag[])
        .filter((flag) => typeof parsed[flag] === "boolean")
        .map((flag) => [flag, parsed[flag] as boolean])
    )
  } catch {
    return {}
  }
}

export function getProviderCatalogFeatureFlags(): ProviderCatalogFeatureFlags {
  return { ...DEFAULT_FLAGS, ...storedOverrides() }
}

export function isProviderCatalogFeatureEnabled(flag: ProviderCatalogFeatureFlag): boolean {
  return getProviderCatalogFeatureFlags()[flag]
}
