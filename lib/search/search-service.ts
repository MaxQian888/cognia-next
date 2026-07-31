/**
 * App binding for the extracted `@cognia/web-search` search service
 * (ADR-0068 E2). The framework-agnostic core lives in the package; this
 * module keeps the historical `@/lib/search/search-service` specifier stable
 * for its ~19 importers and wires the one piece of app runtime the core
 * injected away: per-provider usage stats flowing into the settings store.
 */

import type { SearchProviderType } from "@cognia/web-search/types"
import { setSearchUsageReporter } from "@cognia/web-search/search-service"

import { useSettingsStore } from "@/stores/settings"

export * from "@cognia/web-search/search-service"

// Registered at module scope so every consumer of this binding (all app-side
// search callers) gets usage recording exactly as before the extraction.
// Best-effort by contract: the reporter swallows nothing itself — the core
// wraps the call in try/catch.
setSearchUsageReporter((providerId: SearchProviderType, responseTime, success) => {
  const fn = (
    useSettingsStore.getState() as {
      incrementSearchUsage?: (id: SearchProviderType, ms: number, ok: boolean) => void
    }
  ).incrementSearchUsage
  if (typeof fn === "function") {
    fn(providerId, responseTime, success)
  }
})
