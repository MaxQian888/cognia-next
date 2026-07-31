import type {
  A2UIWidgetHostStrategy,
  A2UIWidgetMetadata,
  A2UIWidgetTheme,
} from "@/types/a2ui/schema"
import { DEFAULT_CATALOG_ID, getRegisteredCatalogIds } from "./catalog"

export const DEFAULT_A2UI_PERSISTENCE_LIMIT = 20
export const MIN_A2UI_PERSISTENCE_LIMIT = 5
export const MAX_A2UI_PERSISTENCE_LIMIT = 100

export interface A2UIRuntimeSettings {
  a2uiDefaultCatalogId?: string
  a2uiDefaultHostStrategy?: A2UIWidgetHostStrategy
  a2uiDefaultTheme?: A2UIWidgetTheme
  a2uiPersistenceLimit?: number
}

export function getA2UIPersistenceLimit(settings?: A2UIRuntimeSettings | null): number {
  const configured = settings?.a2uiPersistenceLimit
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_A2UI_PERSISTENCE_LIMIT
  }

  return Math.min(
    MAX_A2UI_PERSISTENCE_LIMIT,
    Math.max(MIN_A2UI_PERSISTENCE_LIMIT, Math.trunc(configured))
  )
}

export function resolveA2UICatalogId(
  surfaceCatalogId?: string,
  configuredCatalogId?: string
): string {
  if (surfaceCatalogId) {
    return surfaceCatalogId
  }

  if (configuredCatalogId && getRegisteredCatalogIds().includes(configuredCatalogId)) {
    return configuredCatalogId
  }

  return DEFAULT_CATALOG_ID
}

export function getA2UIWidgetSettingDefaults(
  settings?: A2UIRuntimeSettings | null
): Partial<Pick<A2UIWidgetMetadata, "hostStrategy" | "theme">> {
  return {
    ...(settings?.a2uiDefaultHostStrategy
      ? { hostStrategy: settings.a2uiDefaultHostStrategy }
      : {}),
    ...(settings?.a2uiDefaultTheme ? { theme: settings.a2uiDefaultTheme } : {}),
  }
}
