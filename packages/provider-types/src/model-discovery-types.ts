/**
 * Pure model-discovery vocabulary shared by the catalog, the operation
 * contract and the runtime discovery services. Moved here from
 * `@cognia/provider-core/providers/model-discovery` so the types package can
 * reference them without depending on the runtime package. provider-core
 * re-exports them, so existing call sites are untouched.
 */

import type { ProviderModelDiscoveryEntry } from "./provider"

export const PROVIDER_MODEL_SOURCES = [
  "catalog-static",
  "models-dev",
  "remote-discovered",
  "user-curated",
] as const
export type ProviderModelSource = (typeof PROVIDER_MODEL_SOURCES)[number]

export const PROVIDER_MODEL_FRESHNESS = ["static", "fresh", "stale"] as const
export type ProviderModelFreshness = (typeof PROVIDER_MODEL_FRESHNESS)[number]

export type ProviderModelCandidate = ProviderModelDiscoveryEntry
