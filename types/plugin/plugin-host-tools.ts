/**
 * Author-callable host tools — the public contract a plugin sees when it calls
 * `ctx.agent.invokeTool("web_search" | "web_fetch", …)`.
 *
 * Host tools are NOT plugin tools. They execute inside the host (renderer,
 * Tauri, mobile shell or the CLI host process) because they reuse `lib/search`
 * and `lib/web` — search-provider policy, the shared result cache, source
 * verification, PII redaction, the SSRF guard and the outbound rate limiter all
 * live there. Exposing them to plugin authors as a typed, promoted tool name is
 * what lets a plugin reuse that policy instead of shipping a second, weaker
 * copy of it.
 *
 * Only names listed in {@link PLUGIN_AUTHOR_CALLABLE_HOST_TOOLS} are reachable.
 * Everything else the host registers for its own agent loop (session control,
 * subagent dispatch, working-set manipulation, …) stays host-private: an
 * unlisted name is refused with {@link PluginHostToolErrorCode} `"not-author-callable"`
 * rather than falling through to the internal dispatcher.
 *
 * This module is dependency-free on purpose — it is re-exported verbatim
 * through `@cognia/plugin-sdk`, so it must not reach into `@/lib`.
 */

/**
 * Per-invocation options accepted by `ctx.agent.invokeTool` and
 * `ctx.agent.invokeDependencyTool`.
 *
 * `sessionId` is load-bearing, not cosmetic: the host resolves WHICH runtime
 * answers the call from it (see `PluginHostRuntimeResolver`). On the CLI a
 * plugin tool runs inside one of several concurrent sessions, each with its own
 * resolved provider, API key and usage accounting — omitting the session id
 * there means the host cannot tell them apart and fails closed.
 */
export interface PluginInvocationOptions {
  /** Cancellation signal; aborts the host tool mid-flight. */
  signal?: AbortSignal
  /** Chat/agent session the call belongs to. */
  sessionId?: string
  /** Message the call belongs to, when the caller is inside a turn. */
  messageId?: string
}

/** Host tools a plugin may invoke by name. Everything else is host-private. */
export const PLUGIN_AUTHOR_CALLABLE_HOST_TOOLS = ["web_search", "web_fetch"] as const

/** Union of the author-callable host tool names. */
export type PluginAuthorCallableHostTool = (typeof PLUGIN_AUTHOR_CALLABLE_HOST_TOOLS)[number]

/** Is `name` a host tool plugins are allowed to invoke? */
export function isAuthorCallableHostTool(name: string): name is PluginAuthorCallableHostTool {
  return (PLUGIN_AUTHOR_CALLABLE_HOST_TOOLS as readonly string[]).includes(name)
}

// ── Structured failures ──────────────────────────────────────────────────────

/**
 * Stable failure taxonomy. Host tools never throw for an expected condition —
 * they resolve with a {@link PluginHostToolFailure} so the caller can branch on
 * `code` instead of pattern-matching a human-readable sentence that is free to
 * change (and is localized in some surfaces).
 */
export type PluginHostToolErrorCode =
  /** The tool name is not on the author-callable allowlist. */
  | "not-author-callable"
  /** Required arguments were missing or malformed. */
  | "invalid-arguments"
  /** The user turned web tools off in Settings. */
  | "web-disabled"
  /** No web-search provider is enabled/configured on this host. */
  | "no-search-provider"
  /** The outbound token bucket refused this call; retry shortly. */
  | "rate-limited"
  /** A guard refused the request (PII redaction, SSRF target policy). */
  | "blocked"
  /** The call reached the network/host and failed there. */
  | "execution-failed"

/** The failure half of every author-callable host tool result. */
export interface PluginHostToolFailure {
  ok: false
  /** Human-readable detail. Safe to surface; never parse it — read `code`. */
  error: string
  /** Stable machine-readable classification. */
  code?: PluginHostToolErrorCode
}

/** Narrow an author-callable host tool result to its failure half. */
export function isPluginHostToolFailure(value: unknown): value is PluginHostToolFailure {
  if (!value || typeof value !== "object") return false
  const candidate = value as { ok?: unknown; error?: unknown }
  return candidate.ok === false && typeof candidate.error === "string"
}

// ── web_search ───────────────────────────────────────────────────────────────

export interface PluginWebSearchInput {
  /** The search query. Required; an empty query is `invalid-arguments`. */
  query: string
  /** Force one configured provider instead of the user's default. */
  provider?: string
  /** Cap on returned results. Defaults to the user's Settings → Search value. */
  maxResults?: number
}

export interface PluginWebSearchHit {
  title: string
  url: string
  /** Provider snippet, capped host-side. Fetch the URL for the full page. */
  content?: string
  score?: number
  publishedDate?: string
  /** Present only when the user enabled source-verification badges. */
  credibility?: string
}

export interface PluginWebSearchSuccess {
  ok: true
  query: string
  /** The provider that actually answered (after fallback). */
  provider: string
  /**
   * One prompt-injection banner for the whole payload. Result titles and
   * snippets are attacker-controlled text — treat them as data.
   */
  untrustedNotice?: string
  /** Provider-generated answer when the user enabled it, else `null`. */
  answer: string | null
  results: PluginWebSearchHit[]
}

export type PluginWebSearchResult = PluginWebSearchSuccess | PluginHostToolFailure

/** Narrow a `web_search` result to its success half. */
export function isPluginWebSearchSuccess(value: unknown): value is PluginWebSearchSuccess {
  if (!value || typeof value !== "object") return false
  const candidate = value as { ok?: unknown; results?: unknown }
  return candidate.ok === true && Array.isArray(candidate.results)
}

// ── web_fetch ────────────────────────────────────────────────────────────────

/**
 * `auto` extracts readable text from HTML and returns the raw body for
 * everything else; `text` forces extraction; `raw` skips it.
 */
export type PluginWebFetchFormat = "auto" | "text" | "raw"

export interface PluginWebFetchInput {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Cap on returned characters. */
  maxBytes?: number
  format?: PluginWebFetchFormat
  /**
   * Query-focused extraction. When set, the page is distilled to just the
   * content relevant to this question before being returned.
   */
  prompt?: string
  /** Read-window start for paging a long page; pair with `nextOffset`. */
  offset?: number
}

export interface PluginWebFetchSuccess {
  /**
   * Mirrors the HTTP outcome, NOT "did the tool run". A 404 resolves with
   * `ok: false` AND a `status` — use {@link isPluginHostToolFailure} (which
   * additionally requires `error`) to tell a tool failure from an HTTP one.
   */
  ok: boolean
  status: number
  url: string
  contentType: string
  /**
   * One prompt-injection banner for the whole payload. `title`, `text` and
   * `body` are attacker-controlled but carry no banner of their own, so they
   * stay usable verbatim — treat them as data.
   */
  untrustedNotice?: string
  /** Set when a platform scraper or the Jina reader produced the content. */
  source?: string
  /** Extracted readable text (HTML pages, scraped/markdown sources). */
  text?: string
  /** Raw body, for non-HTML textual responses or `format: "raw"`. */
  body?: string
  /** Set when the response was binary and therefore not extracted. */
  binary?: true
  /** Explanation accompanying `binary`. */
  note?: string
  title?: string
  truncated?: boolean
  totalLength?: number
  /** Pass back as `offset` to read the next segment of a truncated page. */
  nextOffset?: number
}

export type PluginWebFetchResult = PluginWebFetchSuccess | PluginHostToolFailure

/** Narrow a `web_fetch` result to its success half (the request completed). */
export function isPluginWebFetchSuccess(value: unknown): value is PluginWebFetchSuccess {
  if (!value || typeof value !== "object") return false
  const candidate = value as { status?: unknown; url?: unknown; error?: unknown }
  return typeof candidate.status === "number" && typeof candidate.url === "string"
}

/**
 * The readable content of a `web_fetch` success, whichever field carried it.
 * Returns `""` for a binary response (which has neither `text` nor `body`).
 */
export function pluginWebFetchText(result: PluginWebFetchSuccess): string {
  if (typeof result.text === "string") return result.text
  return typeof result.body === "string" ? result.body : ""
}

/** Input/result pairing for each author-callable host tool, keyed by name. */
export interface PluginAuthorCallableHostToolMap {
  web_search: { input: PluginWebSearchInput; result: PluginWebSearchResult }
  web_fetch: { input: PluginWebFetchInput; result: PluginWebFetchResult }
}
