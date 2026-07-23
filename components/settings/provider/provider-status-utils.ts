"use client"

import type { ProviderConnectionStatus } from "./provider-sidebar-item"

/**
 * Maps sidebar category filters to the catalog categories that belong in each.
 * Keep in sync with the `category` field on `BuiltInProviderCatalogEntry`.
 */
const CATEGORY_MAP: Record<string, string[]> = {
  ai: ["flagship"],
  local: ["local"],
  voice: ["specialized"],
  vision: ["flagship", "specialized"],
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
  if (category === "vision") {
    return (
      cfg.category !== undefined &&
      categories.includes(cfg.category) &&
      cfg.models.some((m) => m.supportsVision)
    )
  }
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

// Imported here so this file stays self-contained for tests; the catalog is
// used only by `providerMatchesCategory` above.
import { PROVIDERS } from "@cognia/provider-types/provider"
