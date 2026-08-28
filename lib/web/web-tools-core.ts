/**
 * Shared implementation for the first-class web tools (web_search + web_fetch).
 *
 * Shared by the promoted built-in tools and the web-tools plugin wrappers.
 * Search requires the host-owned canonical executor, so renderer and CLI hosts
 * supply settings without this module importing Zustand or duplicating policy.
 *
 * Reuses the app's existing infrastructure rather than reimplementing:
 *   - configured multi-provider web search → `lib/search/configured-search-core`
 *   - readable HTML → text extraction → `lib/document/parsers/html-parser`
 */

import {
  type SearchProviderType,
  type SearchOptions,
  type SearchResponse,
  type SourceVerificationSettings,
} from "@cognia/web-search/types"
import { applySourceVerificationPolicy, verifySource } from "@cognia/web-search/source-verification"
import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"
import { parseHTML } from "@cognia/document/parsers/html-parser"
import { fetchCacheKey, type FetchCacheLike } from "@/lib/web/fetch-cache"
import { scrapePlatform } from "@/lib/web/reader/dispatch"
import { fetchViaJina } from "@/lib/web/reader/jina"
import { assertFetchTargetAllowed, FetchTargetBlockedError } from "@/lib/web/fetch-guard"
import { UNTRUSTED_CONTENT_NOTICE } from "./untrusted-content"
import type { PluginHostToolErrorCode } from "@/types/plugin/plugin-host-tools"

/** How `web_fetch` should present the response body. */
export type FetchFormat = "auto" | "text" | "raw"

export interface WebFetchArgs {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  maxBytes?: number
  /**
   * `auto` (default) extracts readable text for HTML responses and returns the
   * raw body for everything else; `text` forces extraction; `raw` skips it.
   */
  format?: FetchFormat
  /**
   * Query-focused extraction. When set (and a `summarize` dep is available),
   * the extracted page text is distilled to just the content relevant to this
   * question before being returned — collapsing a full page (tens of thousands
   * of tokens) to a short, on-topic answer. Falls back to truncated page text
   * when no summarizer is available or the call fails.
   */
  prompt?: string
  /**
   * Read-window start (char offset) for paging through a long page. When the
   * result was `truncated`, it reports a `nextOffset`; pass it back here to read
   * the next segment instead of re-fetching the whole page. Defaults to 0.
   */
  offset?: number
}

export interface WebSearchArgs {
  query: string
  /** Force a specific provider; defaults to the user's configured default. */
  provider?: SearchProviderType
  maxResults?: number
}

export interface WebFetchDeps {
  /** Optional User-Agent header for outbound requests. */
  userAgent?: string
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Query-focused extractor. When present and `args.prompt` is set, the
   * extracted page text is passed through this to return only the relevant
   * content. The host builds it from the cheap utility model
   * (see {@link buildFetchExtractor}); absent on hosts without a usable model
   * key, in which case the full (truncated) page text is returned.
   */
  summarize?: FetchSummarize
  /** Forwarded to `summarize` so an aborted turn cancels the extraction call. */
  signal?: AbortSignal
  /** Optional TTL/LRU cache for repeated GETs (host passes `getFetchCache()`). */
  cache?: FetchCacheLike
  /**
   * Enable the Jina Reader fallback (`r.jina.ai`) for pages the local cheerio
   * parser can't read (JS-rendered SPAs). Off by default so the pure core /
   * tests never reach a third party; the renderer host turns it on. Platform
   * scrapers (WeChat/X/YouTube) run regardless of this flag.
   */
  jinaFallback?: boolean
  /**
   * Allow fetching private/loopback/link-local hosts (localhost, 10./192.168.,
   * 169.254.x cloud metadata, …). Off by default — the SSRF guard blocks them
   * so a model-supplied URL can't reach the user's internal network. The
   * renderer host forwards the user's Settings → Search opt-in.
   */
  allowPrivateHosts?: boolean
  /**
   * Always distill fetched page text through {@link FetchSummarize} even when
   * the model didn't pass a `prompt` — the main agent then never sees raw page
   * text (Claude-Code-style isolation). No-op when no `summarize` is available.
   */
  alwaysDistill?: boolean
}

/** Distill page text down to just the content relevant to `prompt`. */
export type FetchSummarize = (text: string, prompt: string, signal?: AbortSignal) => Promise<string>

/**
 * Minimal cheap-model client shape (a subset of `LlmClient` from
 * `lib/twin/distill/llm`) — declared locally so the pure core doesn't import
 * the renderer LLM stack.
 */
export interface FetchExtractorClient {
  complete(
    prompt: string,
    options?: {
      system?: string
      temperature?: number
      maxTokens?: number
      abortSignal?: AbortSignal
    }
  ): Promise<string>
}

/** System prompt for query-focused page extraction. */
export const FETCH_EXTRACT_SYSTEM_PROMPT =
  "You extract only the parts of a web page that answer the user's question. " +
  "Return the relevant facts, quotes, numbers, names, dates and URLs concisely, " +
  "preserving them verbatim. If the page does not address the question, say so " +
  "in one line. Do not add a preamble like 'Here is'. Write in the question's language."

/** Hard ceiling on page characters fed to the extractor (keeps the cheap call bounded). */
const FETCH_EXTRACT_INPUT_MAX = 32 * 1024

/**
 * Wrap a cheap-model client into a {@link FetchSummarize}. The host (renderer
 * via `buildUtilityLlmClient`, CLI via its own resolver) calls this once and
 * passes the result as `deps.summarize`.
 */
export function buildFetchExtractor(client: FetchExtractorClient): FetchSummarize {
  return async (text, prompt, signal) => {
    const bounded =
      text.length > FETCH_EXTRACT_INPUT_MAX ? text.slice(0, FETCH_EXTRACT_INPUT_MAX) : text
    const safePrompt = redactText(prompt).redacted
    const safeText = redactText(bounded).redacted
    const extractionPrompt = `Question:\n${safePrompt}\n\nPage content:\n${safeText}`
    if (
      !hasNoLeakingPiiDeep({
        prompt: extractionPrompt,
        system: FETCH_EXTRACT_SYSTEM_PROMPT,
      })
    ) {
      throw new Error("Web extraction blocked: sensitive data remains after redaction")
    }
    const out = await client.complete(extractionPrompt, {
      system: FETCH_EXTRACT_SYSTEM_PROMPT,
      temperature: 0.2,
      maxTokens: 1024,
      abortSignal: signal,
    })
    return (out ?? "").trim()
  }
}

/**
 * What `webSearch` needs, and nothing more.
 *
 * Provider settings, the result cache, fallback and retry counts, and query
 * optimization all moved into the canonical executor
 * (`lib/search/configured-search-core`). They are deliberately NOT re-declared
 * here: fields a host populates but this module never reads read as live
 * configuration and drift silently.
 */
export interface WebSearchDeps {
  /** Host-owned canonical search policy (settings, PII, cache, fallback, filtering). */
  searchExecutor?: (
    query: string,
    options: SearchOptions & { provider?: SearchProviderType }
  ) => Promise<SearchResponse>
  /** Default max results when the caller doesn't specify. */
  searchMaxResults?: number
  /**
   * The user's configured default search options (type, depth, recency,
   * country, language, include/exclude domains, includeAnswer). Forwarded to
   * the search service so the agent honors Settings → Search instead of
   * ignoring it.
   */
  searchOptions?: SearchOptions
  /**
   * Source-verification settings. When `enabled`, results are filtered by
   * blocked domains / minimum credibility and sorted by credibility, reusing
   * the existing `lib/search/source-verification` engine.
   */
  sourceVerification?: SourceVerificationSettings
}

/**
 * Classify a thrown failure for the structured `code` field.
 *
 * The SSRF guard (`assertFetchTargetAllowed`) refuses a target by throwing, so
 * without this a policy refusal would arrive indistinguishable from a DNS error
 * or a socket reset — and a caller could not tell "you may not fetch that" from
 * "that host is down". Matched on the error TYPE, not its message, so the
 * classification survives rewording and localization.
 */
function executionFailureCode(err: unknown): PluginHostToolErrorCode {
  return err instanceof FetchTargetBlockedError ? "blocked" : "execution-failed"
}

/** Default cap on the raw body returned to the model (chars). */
const DEFAULT_MAX = 64 * 1024
/** Default cap on EXTRACTED page text when the caller didn't set `maxBytes`. */
const DEFAULT_EXTRACT_MAX = 40 * 1024
/** Per-result snippet cap in `web_search` results. */
const SNIPPET_MAX = 300
/**
 * Below this many chars of local extraction, treat the page as "unreadable"
 * locally (a JS-rendered SPA) and — when enabled — try the Jina fallback.
 */
const MIN_LOCAL_EXTRACT = 200

/** Generic distillation question used when `alwaysDistill` is on but the model gave no `prompt`. */
const GENERIC_DISTILL_PROMPT =
  "Summarize the key facts, figures, names, dates, quotes, and conclusions on this page."

// Re-exported from `./untrusted-content`, which owns them so that callers
// outside the web stack (the composer's entity mentions, remote-document
// staging) can wrap text without importing the search service and the reader.
export { UNTRUSTED_CONTENT_NOTICE, wrapUntrustedContent } from "./untrusted-content"

/**
 * Slice a `[offset, offset+cap)` window out of `text` for adaptive segmented
 * reading. Reports the total length and the offset to read next when more
 * content remains, so the model can page through a long page instead of
 * re-fetching it whole.
 */
export function windowText(
  text: string,
  offset: number | undefined,
  cap: number
): { slice: string; total: number; start: number; truncated: boolean; nextOffset?: number } {
  const total = text.length
  const start = offset && offset > 0 ? Math.min(Math.floor(offset), total) : 0
  const slice = text.slice(start, start + cap)
  const end = start + slice.length
  const truncated = end < total
  return { slice, total, start, truncated, ...(truncated ? { nextOffset: end } : {}) }
}

/**
 * Textual content types `web_fetch` returns as-is. Everything else (PDF, images,
 * archives, octet-stream, …) is treated as binary and never decoded as text.
 * An empty/absent content type is treated as textual (many servers omit it).
 */
function isTextualContentType(contentType: string): boolean {
  if (!contentType.trim()) return true
  const c = contentType.toLowerCase()
  if (c.startsWith("text/")) return true
  return /(json|xml|xhtml|javascript|ecmascript|csv|yaml|html|markdown|graphql|x-www-form-urlencoded|plain)/.test(
    c
  )
}

/** True when the response looks like a PDF (by content type or URL suffix). */
function looksLikePdf(contentType: string, url: string): boolean {
  return /application\/pdf/i.test(contentType) || /\.pdf(?:$|[?#])/i.test(url)
}

/**
 * Distill (via `prompt`, or a generic question when `alwaysDistill` is on) then
 * truncate extracted text to `cap`. All external text stays framed as
 * untrusted, including distilled output. Never throws — distillation failures
 * fall back to the extracted text.
 */
async function shapeExtracted(
  rawText: string,
  title: string | undefined,
  args: WebFetchArgs,
  deps: WebFetchDeps,
  cap: number
): Promise<{
  text: string
  truncated: boolean
  title?: string
  totalLength?: number
  nextOffset?: number
}> {
  let text = rawText.trim()
  // Query-focused (or, with alwaysDistill, generic) distillation collapses the
  // page to a sub-model summary the main agent can trust.
  const question = args.prompt ?? (deps.alwaysDistill ? GENERIC_DISTILL_PROMPT : undefined)
  if (text && question && deps.summarize) {
    try {
      const focused = (await deps.summarize(text, question, deps.signal))?.trim()
      if (focused) {
        text = focused
      }
    } catch {
      // Keep the extracted text.
    }
  }
  // Adaptive segmented reading — window `[offset, offset+cap)` out of the text.
  const win = windowText(text, args.offset, cap)
  // Distillation reduces content but does not make an external page trusted.
  // The frame is applied ONCE to the whole payload (`untrustedNotice`), not per
  // field: banner-per-field turned a one-line `title` into a multi-line string
  // and made a JSON `body` unparseable for every consumer.
  const out = win.slice
  return {
    text: out,
    truncated: win.truncated,
    ...(title ? { title } : {}),
    ...(win.total > cap || win.start > 0 ? { totalLength: win.total } : {}),
    ...(win.nextOffset != null ? { nextOffset: win.nextOffset } : {}),
  }
}

/**
 * Perform an HTTP request and return readable content for the model.
 *
 * For HTML responses we return ONLY the extracted `text` (+ `title`) — the raw
 * markup the model shouldn't wade through is dropped, which is the single
 * biggest token saving here. The raw `body` is returned only for non-HTML
 * responses, `format: "raw"`, or when extraction yields nothing. When
 * `args.prompt` + `deps.summarize` are present the extracted text is further
 * distilled to just the relevant content. GET results are served from / stored
 * in `deps.cache` when provided.
 */
export async function webFetch(args: WebFetchArgs, deps: WebFetchDeps = {}): Promise<unknown> {
  const result = await performWebFetch(args, deps)
  // One frame for the whole payload, exactly as `shapeSearchResponse` does it.
  // Applied here rather than inside each branch so `title`, `text` and `body`
  // stay usable verbatim and no success path can forget the frame. A structured
  // failure carries no external text, so it needs none.
  if (
    result &&
    typeof result === "object" &&
    typeof (result as WebFetchShape).status === "number"
  ) {
    return { ...(result as WebFetchShape), untrustedNotice: UNTRUSTED_CONTENT_NOTICE }
  }
  return result
}

/** The success shape `webFetch` frames — an HTTP outcome, not a tool failure. */
type WebFetchShape = Record<string, unknown> & { status?: unknown }

async function performWebFetch(args: WebFetchArgs, deps: WebFetchDeps = {}): Promise<unknown> {
  if (!args.url) {
    return { ok: false as const, code: "invalid-arguments" as const, error: "url is required" }
  }
  const headers: Record<string, string> = { ...(args.headers ?? {}) }
  if (deps.userAgent && !headers["User-Agent"]) headers["User-Agent"] = deps.userAgent
  if (!hasNoLeakingPiiDeep({ url: args.url, headers, body: args.body })) {
    return {
      ok: false as const,
      code: "blocked" as const,
      error: "web_fetch blocked: outbound request contains sensitive data",
    }
  }
  const method = args.method ?? "GET"
  const format: FetchFormat = args.format ?? "auto"
  // Only idempotent, body-less GETs are safe to cache; the prompt is part of
  // the key because it changes the distilled output.
  const cacheable = method.toUpperCase() === "GET" && !args.body
  const cacheKey = cacheable
    ? fetchCacheKey({
        url: args.url,
        method,
        format,
        maxBytes: args.maxBytes,
        prompt: args.prompt,
        offset: args.offset,
      })
    : ""
  if (deps.cache && cacheable) {
    const hit = deps.cache.get(cacheKey)
    if (hit != null) return hit
  }

  const fetchImpl = deps.fetchImpl ?? fetch
  const cap = args.maxBytes && args.maxBytes > 0 ? args.maxBytes : DEFAULT_MAX
  const extractCap = args.maxBytes && args.maxBytes > 0 ? cap : DEFAULT_EXTRACT_MAX
  const mayExtract = format !== "raw"
  const isGet = method.toUpperCase() === "GET"

  try {
    // ── 0. SSRF guard ──────────────────────────────────────────────────────
    // Reject non-http(s) schemes and private/loopback/link-local targets before
    // any network is touched (throws → structured error below), unless the user
    // opted into private hosts.
    assertFetchTargetAllowed(args.url, { allowPrivateHosts: deps.allowPrivateHosts })

    // ── 1. Platform scrapers (WeChat / X / YouTube) ────────────────────────
    // Hostname-keyed and tried before the generic fetch because a bespoke
    // scraper beats generic extraction for those sites. Returns null (no
    // network) for every other host, so this is a no-op for normal pages.
    if (mayExtract && isGet && !args.body) {
      try {
        const scraped = await scrapePlatform(args.url, fetchImpl, deps.signal)
        if (scraped && scraped.markdown.trim()) {
          const shaped = await shapeExtracted(
            scraped.markdown,
            scraped.title,
            args,
            deps,
            extractCap
          )
          const result = {
            ok: true as const,
            status: 200,
            url: args.url,
            contentType: "text/markdown",
            source: scraped.source,
            text: shaped.text,
            truncated: shaped.truncated,
            ...(shaped.title ? { title: shaped.title } : {}),
            ...(shaped.totalLength != null ? { totalLength: shaped.totalLength } : {}),
            ...(shaped.nextOffset != null ? { nextOffset: shaped.nextOffset } : {}),
          }
          if (deps.cache && cacheable) deps.cache.set(cacheKey, result)
          return result
        }
      } catch {
        // Fall through to the generic path.
      }
    }

    // ── 2. Generic fetch + local (cheerio) extraction ──────────────────────
    const res = await fetchImpl(args.url, { method, headers, body: args.body })
    const contentType = res.headers.get?.("content-type") ?? ""

    // ── 2a. Binary / PDF handling ──────────────────────────────────────────
    // Never decode binary as text (the Rust proxy already read the body as a
    // string, so a PDF/image would come back as mojibake). PDFs → Jina, which
    // renders them to markdown; other binaries → a clear note. `format:"raw"`
    // opts out and gets the raw string.
    if (mayExtract && !isTextualContentType(contentType)) {
      const isPdf = looksLikePdf(contentType, args.url)
      if (isPdf && isGet && !args.body && (deps.jinaFallback ?? false)) {
        try {
          const jina = await fetchViaJina(args.url, fetchImpl, deps.signal)
          if (jina && jina.markdown.trim()) {
            const shaped = await shapeExtracted(jina.markdown, jina.title, args, deps, extractCap)
            const result = {
              ok: res.ok,
              status: res.status,
              url: args.url,
              contentType: "text/markdown",
              source: jina.source,
              text: shaped.text,
              truncated: shaped.truncated,
              ...(shaped.title ? { title: shaped.title } : {}),
              ...(shaped.totalLength != null ? { totalLength: shaped.totalLength } : {}),
              ...(shaped.nextOffset != null ? { nextOffset: shaped.nextOffset } : {}),
            }
            if (deps.cache && cacheable && res.ok) deps.cache.set(cacheKey, result)
            return result
          }
        } catch {
          // Fall through to the binary note.
        }
      }
      const result = {
        ok: res.ok,
        status: res.status,
        url: args.url,
        contentType,
        binary: true as const,
        note: isPdf
          ? "PDF content was not extracted to text. Enable the Jina reader in Settings → Search, or fetch with format:'raw'."
          : "Non-text (binary) content was not extracted. Use format:'raw' to get the raw bytes as a string.",
      }
      if (deps.cache && cacheable && res.ok) deps.cache.set(cacheKey, result)
      return result
    }

    const raw = await res.text()
    const wantsExtract = mayExtract && (format === "text" || /html/i.test(contentType))

    let extracted:
      | {
          text: string
          truncated: boolean
          title?: string
          totalLength?: number
          nextOffset?: number
        }
      | undefined
    if (wantsExtract && res.ok && raw) {
      try {
        const parsed = await parseHTML(raw, { includeLinks: false, includeImages: false })
        const text = parsed.text?.trim() ?? ""
        if (text) {
          extracted = await shapeExtracted(text, parsed.title, args, deps, extractCap)
        }
      } catch {
        // Malformed HTML — fall through to the raw body below.
      }
    }

    // ── 3. Jina Reader fallback ────────────────────────────────────────────
    // Only when local extraction came back empty/too thin (a JS-rendered page
    // cheerio can't see) AND the host opted in. Off by default in the pure
    // core; the renderer host enables it.
    if (
      mayExtract &&
      isGet &&
      !args.body &&
      (deps.jinaFallback ?? false) &&
      (!extracted || extracted.text.length < MIN_LOCAL_EXTRACT)
    ) {
      try {
        const jina = await fetchViaJina(args.url, fetchImpl, deps.signal)
        if (jina && jina.markdown.trim().length > (extracted?.text.length ?? 0)) {
          const shaped = await shapeExtracted(jina.markdown, jina.title, args, deps, extractCap)
          const result = {
            ok: res.ok,
            status: res.status,
            url: args.url,
            contentType: "text/markdown",
            source: jina.source,
            text: shaped.text,
            truncated: shaped.truncated,
            ...(shaped.title ? { title: shaped.title } : {}),
            ...(shaped.totalLength != null ? { totalLength: shaped.totalLength } : {}),
            ...(shaped.nextOffset != null ? { nextOffset: shaped.nextOffset } : {}),
          }
          if (deps.cache && cacheable && res.ok) deps.cache.set(cacheKey, result)
          return result
        }
      } catch {
        // Keep local extraction / raw body.
      }
    }

    let result: Record<string, unknown>
    if (extracted != null) {
      result = {
        ok: res.ok,
        status: res.status,
        url: args.url,
        contentType,
        text: extracted.text,
        truncated: extracted.truncated,
        ...(extracted.title ? { title: extracted.title } : {}),
        ...(extracted.totalLength != null ? { totalLength: extracted.totalLength } : {}),
        ...(extracted.nextOffset != null ? { nextOffset: extracted.nextOffset } : {}),
      }
    } else {
      // Raw body path (non-HTML textual responses / extraction yielded nothing).
      // Window it too so the model can page through a large text/JSON payload.
      const win = windowText(raw, args.offset, cap)
      result = {
        ok: res.ok,
        status: res.status,
        url: args.url,
        contentType,
        body: win.slice,
        truncated: win.truncated,
        ...(win.total > cap || win.start > 0 ? { totalLength: win.total } : {}),
        ...(win.nextOffset != null ? { nextOffset: win.nextOffset } : {}),
      }
    }

    if (deps.cache && cacheable && res.ok) deps.cache.set(cacheKey, result)
    return result
  } catch (err) {
    return {
      ok: false as const,
      code: executionFailureCode(err),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Filter + reorder results through the source-verification engine when the
 * user enabled it: drop blocked domains, drop below-minimum-credibility results
 * (when auto-filter is on), then sort most-credible-first. Pure; no-op when
 * verification is disabled.
 */
/** Map a raw `SearchResponse` into the compact, token-bounded tool result. */
function shapeSearchResponse(
  query: string,
  response: SearchResponse,
  sv: SourceVerificationSettings | undefined
): unknown {
  const verified = applySourceVerificationPolicy(response.results, sv)
  const withBadges = Boolean(sv?.enabled && sv.showVerificationBadges)
  return {
    ok: true as const,
    query,
    provider: response.provider,
    // One frame for the whole payload instead of one per field. Wrapping every
    // title AND every snippet repeated this ~137-char banner up to 2N+1 times
    // per search (~700 tokens of boilerplate on ten results) and turned each
    // one-line `title` into a multi-line string every consumer had to unwrap.
    untrustedNotice: UNTRUSTED_CONTENT_NOTICE,
    answer: response.answer ?? null,
    // Structured results only — the previous `formatted` markdown block
    // duplicated every snippet a second time. Each snippet is capped so a
    // chatty provider can't blow up the tool-result token cost; the model
    // can `web_fetch` a result URL when it needs the full page.
    results: verified.map((r) => ({
      title: r.title,
      url: r.url,
      content:
        typeof r.content === "string" && r.content.length > SNIPPET_MAX
          ? r.content.slice(0, SNIPPET_MAX) + "…"
          : r.content,
      score: r.score,
      ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
      ...(withBadges ? { credibility: verifySource(r.url).credibilityLevel } : {}),
    })),
  }
}

/** Multi-provider web search over the user's configured providers. */
export async function webSearch(args: WebSearchArgs, deps: WebSearchDeps = {}): Promise<unknown> {
  const rawQuery = typeof args.query === "string" ? args.query.trim() : ""
  if (!rawQuery) {
    return { ok: false as const, code: "invalid-arguments" as const, error: "query is required" }
  }
  const maxResults =
    typeof args.maxResults === "number"
      ? args.maxResults
      : typeof deps.searchMaxResults === "number"
        ? deps.searchMaxResults
        : undefined
  if (!deps.searchExecutor) {
    return {
      ok: false as const,
      code: "no-search-provider" as const,
      error:
        "No web search provider is configured. Enable one and add its API key in Settings → Search.",
    }
  }
  try {
    const response = await deps.searchExecutor(rawQuery, {
      ...(deps.searchOptions ?? {}),
      ...(args.provider ? { provider: args.provider } : {}),
      ...(maxResults != null ? { maxResults } : {}),
    })
    return shapeSearchResponse(response.query || rawQuery, response, deps.sourceVerification)
  } catch (err) {
    return {
      ok: false as const,
      code: executionFailureCode(err),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
