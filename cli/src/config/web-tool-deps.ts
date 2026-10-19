/** CLI adapter for the promoted web_search / web_fetch executor. */
import { WEB_READER_IDS } from "@cognia/agent-config-types"

import type { WebToolRunDeps } from "@/lib/claude/web-builtin-tools"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { configuredSearchProviders } from "@/lib/chat/web-access"
import { searchWithSettings } from "@/lib/search/configured-search-core"
import { getFetchCache } from "@/lib/web/fetch-cache"
import { readerPolicyFromSettings } from "@/lib/web/reader/reader-settings"
import { buildFetchExtractor } from "@/lib/web/web-tools-core"

import { createGuardedWebFetch } from "./guarded-web-fetch"
import type { ResolvedConfig } from "./schema"
import { toBuildContext } from "./to-build-context"

/** Resolve host policy entirely from the CLI's files/env, without renderer state. */
export function buildCliWebToolDeps(config: ResolvedConfig): WebToolRunDeps {
  // ResolvedConfig exposes the CLI home (profile identity), not a session id.
  const scope = config.cliHome ? `cli:${config.cliHome}` : "cli"
  const { appSettings: settings, session } = toBuildContext({ sessionId: scope, config })
  const client = buildUtilityLlmClient({
    session,
    appSettings: settings,
    featureId: "web_fetch_extract",
  })

  const allowPrivateHosts = settings?.webTools?.allowPrivateHosts === true

  return {
    enabled: config.webTools !== false,
    // Connection-time DNS guard: the Reader checks URLs and redirect hops, this
    // refuses a public name that resolves to a private address.
    fetchImpl: createGuardedWebFetch({ allowPrivateHosts }),
    allowPrivateHosts,
    readerPolicy: readerPolicyFromSettings(settings),
    credentialFor: (id) => settings?.searchProviders?.[id]?.apiKey?.trim() || undefined,
    cache: getFetchCache(),
    scope,
    activeScope: () => scope,
    hostReachable: Object.fromEntries(WEB_READER_IDS.map((id) => [id, true])),
    transportCancels: true,
    ...(client ? { summarize: buildFetchExtractor(client) } : {}),
    // Defaults remain in the snapshot, below explicit caller options (R05).
    ...(configuredSearchProviders(settings?.searchProviders, settings?.defaultSearchProvider)
      .length > 0
      ? {
          searchExecutor: ((query, options) =>
            searchWithSettings(query, {
              settings: settings ?? undefined,
              options,
              signal: options.signal,
              scope,
              activeScope: () => scope,
              useCache: settings?.searchCacheEnabled !== false,
            })) satisfies NonNullable<WebToolRunDeps["searchExecutor"]>,
        }
      : {}),
  }
}
