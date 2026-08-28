/** CLI adapter for the promoted web_search / web_fetch executor. */
import type { AppSettings } from "@cognia/agent-config-types"

import type { WebToolRunDeps } from "@/lib/claude/web-builtin-tools"
import { configuredSearchProviders } from "@/lib/chat/web-access"
import { searchWithSettings } from "@/lib/search/configured-search-core"

import type { ResolvedConfig } from "./schema"
import { buildSearchAppSettings } from "./to-build-context"

/**
 * Resolve web-tool dependencies entirely from CLI files/env. The explicit
 * settings snapshot uses the store-independent executor, preserving the
 * canonical PII/cache/provider policy without importing renderer state.
 */
export function buildCliWebToolDeps(config: ResolvedConfig): WebToolRunDeps {
  const settings = {
    webTools: { enabled: config.webTools !== false },
    ...buildSearchAppSettings(config),
  } as AppSettings

  return {
    enabled: config.webTools !== false,
    searchMaxResults: settings.searchMaxResults,
    // No `searchOptions` projection. Type, depth, recency, country, language,
    // include/exclude domains, answer, raw content and safe-search are all
    // derived from this same `settings` snapshot by `defaultSearchOptions`
    // inside the executor. Re-deriving them here only to hand them back as
    // request-level OVERRIDES is the layer that silently replaced the
    // renderer's selected domain filter with the legacy `defaultIncludeDomains`
    // (see the comment in `lib/claude/plugin-tool-ipc.ts`). One derivation, in
    // the executor that owns the policy.
    ...(configuredSearchProviders(settings.searchProviders, settings.defaultSearchProvider).length >
    0
      ? {
          searchExecutor: ((query, options) =>
            searchWithSettings(query, {
              settings,
              options,
              useCache: settings.searchCacheEnabled !== false,
            })) satisfies NonNullable<WebToolRunDeps["searchExecutor"]>,
        }
      : {}),
  }
}
