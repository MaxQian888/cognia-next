/**
 * First-class web tools, promoted out of the `web-tools` plugin.
 *
 * These are surfaced to the agent as plugin-manifest entries (same wire as
 * `ask_user` / `dispatch_agent`) but are ALWAYS available and ungated by the
 * `pluginTools` toggle. They execute host-side (renderer + CLI host) because
 * they reuse `lib/search` + `lib/document` — the pure `.mjs` sidecar can't
 * import TS. `build-options` appends {@link buildWebBuiltinManifestEntries}
 * when the web capability is on and filters the plugin's duplicate
 * `web_search`/`web_fetch` so the model sees exactly one of each;
 * `plugin-tool-ipc` resolves the calls via {@link runWebBuiltinTool}.
 */

import {
  webFetch,
  webSearch,
  type WebFetchArgs,
  type WebSearchArgs,
  type WebFetchDeps,
  type WebSearchDeps,
} from "@/lib/web/web-tools-core"

export const WEB_SEARCH_TOOL_NAME = "web_search"
export const WEB_FETCH_TOOL_NAME = "web_fetch"

/** Synthetic plugin id used to tag the promoted built-in web manifest entries. */
export const WEB_BUILTIN_PLUGIN_ID = "cognia-web-builtin"

const WEB_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "The search query." },
    provider: { type: "string", description: "Force a specific configured provider (optional)." },
    maxResults: { type: "number", description: "Maximum number of results (optional)." },
  },
  required: ["query"],
} as const

const WEB_FETCH_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to fetch." },
    method: { type: "string", description: "HTTP method (default GET)." },
    headers: { type: "object", description: "Optional request headers." },
    body: { type: "string", description: "Optional request body." },
    maxBytes: { type: "number", description: "Cap on returned bytes (default 256 KB)." },
    format: {
      type: "string",
      enum: ["auto", "text", "raw"],
      description: "auto extracts readable text for HTML; text forces it; raw skips it.",
    },
  },
  required: ["url"],
} as const

export interface WebBuiltinManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
}

/**
 * Manifest entries for the promoted web tools. Appended to `opts.pluginTools`
 * by `build-options` when the web capability is enabled.
 */
export function buildWebBuiltinManifestEntries(): WebBuiltinManifestEntry[] {
  return [
    {
      name: WEB_SEARCH_TOOL_NAME,
      description:
        "Search the web via the user's configured provider (Tavily/Brave/Exa/Google/…) and return ranked results with an optional AI answer.",
      jsonSchema: WEB_SEARCH_SCHEMA as unknown as Record<string, unknown>,
      pluginId: WEB_BUILTIN_PLUGIN_ID,
    },
    {
      name: WEB_FETCH_TOOL_NAME,
      description:
        "Perform an HTTP request and return the response body. For HTML pages, also returns readable extracted `text` and the page `title`.",
      jsonSchema: WEB_FETCH_SCHEMA as unknown as Record<string, unknown>,
      pluginId: WEB_BUILTIN_PLUGIN_ID,
    },
  ]
}

/** Is this tool name one of the promoted web built-ins? */
export function isWebBuiltinTool(name: string): boolean {
  return name === WEB_SEARCH_TOOL_NAME || name === WEB_FETCH_TOOL_NAME
}

export type WebToolRunDeps = WebFetchDeps & WebSearchDeps

/**
 * Execute a promoted web tool host-side. Called from `plugin-tool-ipc`'s
 * `plugin_tool_exec` handler, which supplies the resolved provider settings.
 */
export async function runWebBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: WebToolRunDeps
): Promise<unknown> {
  if (name === WEB_FETCH_TOOL_NAME) {
    return webFetch(args as unknown as WebFetchArgs, {
      userAgent: deps.userAgent,
      fetchImpl: deps.fetchImpl,
    })
  }
  if (name === WEB_SEARCH_TOOL_NAME) {
    return webSearch(args as unknown as WebSearchArgs, {
      providerSettings: deps.providerSettings,
      searchMaxResults: deps.searchMaxResults,
      searchFallbackEnabled: deps.searchFallbackEnabled,
    })
  }
  return { ok: false as const, error: `unknown web tool: ${name}` }
}
