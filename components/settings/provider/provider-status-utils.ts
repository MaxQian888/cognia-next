"use client"

import type { ProviderConnectionStatus } from "./provider-sidebar-item"
import type { ProviderUIPreferences } from "@cognia/provider-types/provider"
import type { BuiltInProviderCategory } from "@cognia/provider-types/built-in-provider-catalog"

/**
 * Rail category filters, in tab order. Every value of
 * `BuiltInProviderCategory` now has a filter of its own.
 *
 * `enterprise` (Cohere / Bedrock / Azure) used to fold into "flagship" on the
 * grounds that those hosts serve flagship models. That left a tab whose label
 * named one thing and whose contents were two, and it made `enterprise` the
 * only catalog category with no way to ask for it.
 *
 * Note this is the catalog's `category`, not the `quickAdd.category` region
 * tag (`china` / `global` / `proxy`) that lives on the same entries. Those are
 * a different axis and are read only by the quick-add dialog.
 */
export const PROVIDER_CATEGORY_FILTERS = [
  "all",
  "flagship",
  "enterprise",
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
 * Maps a rail category filter to the catalog categories it claims.
 *
 * Typed against `BuiltInProviderCategory` rather than `string[]` on purpose. A
 * sixth catalog category is a compile error here, which is the only thing that
 * stops it from being silently unreachable through every filter but "all".
 */
export const CATEGORY_MAP: Record<
  Exclude<ProviderCategoryFilter, "all" | "custom">,
  readonly BuiltInProviderCategory[]
> = {
  flagship: ["flagship"],
  enterprise: ["enterprise"],
  specialized: ["specialized"],
  aggregator: ["aggregator"],
  local: ["local"],
}

/**
 * Decide whether a built-in provider belongs in the given rail category.
 *
 * An unrecognised filter matches nothing. It used to match everything, which
 * reads as "show the whole list" but is the wrong default now that the filter
 * is about to arrive from a URL: a typo would silently widen the list instead
 * of showing that the filter did not apply.
 */
export function providerMatchesCategory(category: string, providerId: string): boolean {
  if (category === "all") return true
  if (category === "custom") return false
  const categories = CATEGORY_MAP[category as Exclude<ProviderCategoryFilter, "all" | "custom">]
  if (!categories) return false
  const cfg = PROVIDERS[providerId]
  if (!cfg) return false
  return cfg.category !== undefined && categories.includes(cfg.category as BuiltInProviderCategory)
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
