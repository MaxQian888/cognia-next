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

/**
 * The catalog a surface renders with. Most specific first: the catalog the
 * surface itself names (kept even before it is registered, so a late plugin
 * catalog still resolves), then the default of the agent that produced it
 * (`Character.a2uiCatalogId`), then the app-level default. The agent and app
 * defaults only count when registered; anything else falls to the standard
 * catalog.
 */
export function resolveA2UICatalogId(
  surfaceCatalogId?: string,
  configuredCatalogId?: string,
  agentCatalogId?: string
): string {
  if (surfaceCatalogId) {
    return surfaceCatalogId
  }

  const registered = getRegisteredCatalogIds()
  for (const candidate of [agentCatalogId, configuredCatalogId]) {
    if (candidate && registered.includes(candidate)) return candidate
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
