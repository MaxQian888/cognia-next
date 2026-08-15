"use client"

import type { ProviderConnectionStatus } from "./provider-sidebar-item"
import type { ProviderUIPreferences } from "@cognia/provider-types/provider"

/**
 * Rail category filters, in tab order. Mirrors `BuiltInProviderCategory`
 * (`flagship | aggregator | specialized | local | enterprise`) one-to-one so a
 * tab always means what its label says; `enterprise` (Cohere / Bedrock /
 * Azure) folds into "flagship" because those hosts serve flagship models. The
 * previous strip mapped "AI" → flagship only (4 providers) and "Voice" →
 * specialized (33 providers, incl. DeepSeek / Groq / Mistral) — a Voice tab
 * full of text-only vendors.
 */
export const PROVIDER_CATEGORY_FILTERS = [
  "all",
  "flagship",
  "specialized",
  "aggregator",
  "local",
  "custom",
] as const

export type ProviderCategoryFilter = (typeof PROVIDER_CATEGORY_FILTERS)[number]

/** Persisted values from the retired strip (`ai` / `voice` / `vision`) → all. */
export function normalizeCategoryFilter(value: string | undefined | null): ProviderCategoryFilter {
  return (PROVIDER_CATEGORY_FILTERS as readonly string[]).includes(value ?? "")
    ? (value as ProviderCategoryFilter)
    : "all"
}

/**
 * Maps sidebar category filters to the catalog categories that belong in each.
 * Keep in sync with the `category` field on `BuiltInProviderCatalogEntry`.
 */
const CATEGORY_MAP: Record<string, string[]> = {
  flagship: ["flagship", "enterprise"],
  specialized: ["specialized"],
  aggregator: ["aggregator"],
  local: ["local"],
}

/**
 * Decide whether a built-in provider belongs in the given sidebar category.
 */
export function providerMatchesCategory(category: string, providerId: string): boolean {
  if (category === "all") return true
  if (category === "custom") return false
  const categories = CATEGORY_MAP[category]
  if (!categories) return true
  const cfg = PROVIDERS[providerId]
  if (!cfg) return false
  return cfg.category !== undefined && categories.includes(cfg.category)
}

export function deriveStatus(
  apiKey: string | undefined,
  baseURL: string | undefined,
  testOk: boolean | undefined,
  // "limited" means the connection was verified but with caveats (e.g.
  // couldn't be authoritatively confirmed in this runtime) — distinct from
  // a plain pass so the sidebar badge doesn't overclaim "Connected".
  outcome?: "verified" | "failed" | "limited" | "success" | "error" | null,
  configuredOverride = false,
  verificationStatus?: "unverified" | "verified" | "stale" | null
): ProviderConnectionStatus {
  if (!apiKey && !baseURL && !configuredOverride) return "not-configured"
  if (outcome === "limited") return "limited"
  if (testOk === false) return "error"
  if (testOk === true) return "connected"
  // A previously successful verification survives reloads; surface it as
  // connected unless a newer in-session test has already resolved above.
  if (verificationStatus === "verified") return "connected"
  if (verificationStatus === "stale") return "limited"
  // Configured but never tested. NOT a warning — nothing is wrong yet.
  return "untested"
}

/**
 * Local inference engines are keyless and default to a well-known port, so an
 * empty key + empty base URL does NOT mean "not configured" for them — an
 * enabled or previously verified engine is configured by definition. Without
 * this the rail called a running, verified Ollama "Unconfigured".
 */
export function isLocalEngineConfigured(
  providerId: string,
  settings:
    | { enabled?: boolean; verificationStatus?: "unverified" | "verified" | "stale" | null }
    | undefined
): boolean {
  if (PROVIDERS[providerId]?.category !== "local") return false
  return Boolean(settings?.enabled) || settings?.verificationStatus === "verified"
}

export type ProviderSortBy = NonNullable<ProviderUIPreferences["sortBy"]>

/** Status rank for `sortBy: "status"` — healthiest first, unconfigured last. */
const STATUS_RANK: Record<ProviderConnectionStatus, number> = {
  connected: 0,
  limited: 1,
  untested: 2,
  warning: 3,
  error: 4,
  "not-configured": 5,
}

export interface SortableProviderRow {
  id: string
  name: string
  status: ProviderConnectionStatus
  /** Epoch ms of the most recent recorded usage, if any. */
  lastUsedAt?: number
}

/**
 * Stable sort for the rail. Ties (and `name`) fall back to the localized name
 * so the order is deterministic across renders.
 */
export function sortProviderRows<T extends SortableProviderRow>(
  rows: readonly T[],
  sortBy: ProviderSortBy
): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name)
  const sorted = [...rows]
  if (sortBy === "status") {
    sorted.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || byName(a, b))
  } else if (sortBy === "lastUsed") {
    sorted.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || byName(a, b))
  } else {
    sorted.sort(byName)
  }
  return sorted
}

/**
 * Which row the detail pane opens on when nothing is selected yet. The
 * app-wide default provider first (that is what chat uses), then the first
 * connected row, then whatever is first in the list — never the alphabetically
 * first catalog entry ("01.AI") the previous auto-select landed on.
 */
export function pickInitialProviderId(
  rows: ReadonlyArray<{ id: string; status: ProviderConnectionStatus }>,
  defaultProviderId: string | undefined
): string | null {
  if (rows.length === 0) return null
  if (defaultProviderId && rows.some((row) => row.id === defaultProviderId)) {
    return defaultProviderId
  }
  return rows.find((row) => row.status === "connected")?.id ?? rows[0].id
}

// Imported here so this file stays self-contained for tests; the catalog is
// used only by `providerMatchesCategory` / `isLocalEngineConfigured` above.
import { PROVIDERS } from "@cognia/provider-types/provider"
