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
import { getPluginRateLimiter, RateLimitError } from "@/lib/plugin/security/rate-limiter"

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
    maxBytes: { type: "number", description: "Cap on returned characters (default 64 KB)." },
    format: {
      type: "string",
      enum: ["auto", "text", "raw"],
      description:
        "auto extracts readable text for HTML; text forces it; raw returns the raw body.",
    },
    prompt: {
      type: "string",
      description:
        "Optional. What you want from the page — when set, only the content relevant to this is returned instead of the full page (far fewer tokens). Use it whenever you're after specific facts.",
    },
    offset: {
      type: "number",
      description:
        "Optional read-window start (char offset) for paging through a long page. When a result is `truncated`, it returns a `nextOffset` — pass it back here to read the next segment instead of re-fetching.",
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
 * by `build-options` for whichever of the two the turn's resolved web access
 * routes through Cognia (`lib/chat/web-access.ts`).
 *
 * The two are selectable because they fail apart: `web_fetch` needs no API key
 * and works on any install, while `web_search` needs a configured provider and
 * throws "no providers enabled" without one. Shipping both unconditionally is
 * what put a tool in the model's hands that could only fail.
 */
export function buildWebBuiltinManifestEntries(
  include: { search?: boolean; fetch?: boolean } = {}
): WebBuiltinManifestEntry[] {
  const { search = true, fetch = true } = include
  const entries: WebBuiltinManifestEntry[] = []
  if (search)
    entries.push({
      name: WEB_SEARCH_TOOL_NAME,
      description:
        "Search the web via the user's configured provider (Tavily/Brave/Exa/Google/…) and return ranked results with an optional AI answer.",
      jsonSchema: WEB_SEARCH_SCHEMA as unknown as Record<string, unknown>,
      pluginId: WEB_BUILTIN_PLUGIN_ID,
    })
  if (fetch)
    entries.push({
      name: WEB_FETCH_TOOL_NAME,
      description:
        "Fetch a URL. For HTML pages it returns clean extracted `text` (+ `title`), not the raw markup. Pass `prompt` to get back only the content relevant to your question instead of the whole page.",
      jsonSchema: WEB_FETCH_SCHEMA as unknown as Record<string, unknown>,
      pluginId: WEB_BUILTIN_PLUGIN_ID,
    })
  return entries
}

/** Is this tool name one of the promoted web built-ins? */
export function isWebBuiltinTool(name: string): boolean {
  return name === WEB_SEARCH_TOOL_NAME || name === WEB_FETCH_TOOL_NAME
}

export type WebToolRunDeps = WebFetchDeps & WebSearchDeps & { enabled?: boolean }

/**
 * Execute a promoted web tool host-side. Called from `plugin-tool-ipc`'s
 * `plugin_tool_exec` handler, which supplies the resolved provider settings.
 */
export async function runWebBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: WebToolRunDeps
): Promise<unknown> {
  if (deps.enabled === false) {
    return {
      ok: false as const,
      code: "web-disabled" as const,
      error: "Web tools are disabled in Settings.",
    }
  }
  // Governance: the promoted web built-ins run host-side and so bypass the
  // plugin permission-guard/rate-limiter that clamps `ctx.network`. Re-apply an
  // outbound token bucket here (reusing the shared limiter) so a runaway agent
  // can't hammer providers/hosts. A refused call becomes a structured error the
  // model can read, not a thrown exception.
  const op = name === WEB_SEARCH_TOOL_NAME ? "network:search" : "network:fetch"
  try {
    getPluginRateLimiter().check(WEB_BUILTIN_PLUGIN_ID, op)
  } catch (err) {
    if (err instanceof RateLimitError) {
      return {
        ok: false as const,
        code: "rate-limited" as const,
        error: `Rate limit exceeded for ${name}; try again shortly.`,
      }
    }
    throw err
  }

  if (name === WEB_FETCH_TOOL_NAME) {
    return webFetch(args as unknown as WebFetchArgs, {
      userAgent: deps.userAgent,
      fetchImpl: deps.fetchImpl,
      summarize: deps.summarize,
      signal: deps.signal,
      cache: deps.cache,
      jinaFallback: deps.jinaFallback,
      allowPrivateHosts: deps.allowPrivateHosts,
      alwaysDistill: deps.alwaysDistill,
    })
  }
  if (name === WEB_SEARCH_TOOL_NAME) {
    return webSearch(args as unknown as WebSearchArgs, {
      searchExecutor: deps.searchExecutor,
      searchMaxResults: deps.searchMaxResults,
      searchOptions: deps.searchOptions,
      sourceVerification: deps.sourceVerification,
    })
  }
  return {
    ok: false as const,
    code: "invalid-arguments" as const,
    error: `unknown web tool: ${name}`,
  }
}
