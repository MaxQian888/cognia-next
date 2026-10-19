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

import type {
  SearchProviderType,
  SearchOptions,
  SearchResponse,
  SearchType,
  SourceVerificationSettings,
} from "@cognia/web-search/types"
import type { CredentialedWebReaderId, WebReaderId } from "@cognia/agent-config-types"
import { applySourceVerificationPolicy, verifySource } from "@cognia/web-search/source-verification"
import {
  EXTRACTOR_INPUT_MAX_CHARS,
  EXTRACTOR_OUTPUT_MAX_TOKENS,
  MAX_OPERATION_ATTEMPTS,
  READ_TOTAL_BUDGET_MS,
  SEARCH_EXCERPT_MAX_CHARS,
  SEARCH_IMAGES_MAX,
  SEARCH_SNIPPET_MAX_CHARS,
  type OperationAdmission,
} from "@cognia/web-search/operation-policy"
import { isSearchCapabilityError } from "@cognia/web-search/search-type-router"
import { SearchDomainPolicyError } from "@cognia/web-search/search-service"
import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"
import type { FetchCacheLike } from "@/lib/web/fetch-cache"
import { FetchTargetBlockedError } from "@/lib/web/fetch-guard"
import {
  readWithPolicy,
  type FetchFormat,
  type FetchSummarize,
  type ReadRequest,
} from "@/lib/web/reader/configured-reader"
import type { ReaderPolicy } from "@/lib/web/reader/reader-settings"
import { UNTRUSTED_CONTENT_NOTICE } from "./untrusted-content"
import type { PluginHostToolErrorCode } from "@/types/plugin/plugin-host-tools"

export type { FetchFormat, FetchSummarize } from "@/lib/web/reader/configured-reader"
export { windowText } from "@/lib/web/reader/configured-reader"

export interface WebFetchArgs {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Read-window cap in CHARACTERS (legacy name kept for compatibility). */
  maxBytes?: number
  /**
   * `auto` (default) extracts readable text for HTML responses and returns the
   * raw body for everything else; `text` forces extraction; `raw` skips it and
   * is always served by the direct reader.
   */
  format?: FetchFormat
  /**
   * Query-focused extraction. When set (and a `summarize` dep is available),
   * the extracted page text is distilled to just the content relevant to this
   * question. Best-effort unless the Reader policy requires distillation.
   */
  prompt?: string
  /**
   * Read-window start (character offset) for paging through a long page. When
   * the result was `truncated`, it reports a `nextOffset`; pass it back here
   * to read the next segment — served from the cached document when resident.
   */
  offset?: number
  /** Pin one reader (`direct`, `jina`, `tavily`, …). Strict unless `allowFallback`. */
  reader?: WebReaderId
  /** `true` lets a pinned reader fall back; `false` makes the configured default strict. */
  allowFallback?: boolean
}

export interface WebSearchArgs {
  query: string
  /**
   * Preferred provider. Under the user's fallback setting another eligible
   * provider may serve the request; pass `allowFallback: false` to pin it.
   */
  provider?: SearchProviderType
  maxResults?: number
  /** Specialized search type; never silently downgraded to general search. */
  searchType?: SearchType
  /** Provider-scoped SERP engine (e.g. `bing` on SearchAPI). */
  engine?: string
  /** `false` = strict pin: the named provider serves or the call fails. */
  allowFallback?: boolean
  /**
   * Ask for a bounded per-result page excerpt (characters, ≤ 2000) from
   * providers that return page content. Omitted ⇒ snippets only, and no
   * paid full-content extraction is requested.
   */
  excerptChars?: number
}

export interface WebFetchDeps {
  /** Optional User-Agent header for outbound requests. */
  userAgent?: string
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Query-focused extractor built from the cheap utility model
   * (see {@link buildFetchExtractor}); absent on hosts without a usable model.
   */
  summarize?: FetchSummarize
  /** Cancels the whole read: every reader attempt, distillation and cache write. */
  signal?: AbortSignal
  /** Reader cache (host passes `getFetchCache()`). */
  cache?: FetchCacheLike
  /**
   * The configured Reader policy (`readerPolicyFromSettings`). Absent ⇒ a
   * policy derived from the legacy `jinaFallback` / `alwaysDistill` flags.
   */
  readerPolicy?: ReaderPolicy
  /** Runtime/account scope (opaque) for cache and admission isolation. */
  scope?: string
  /** Current scope at completion; a mismatch discards the read. */
  activeScope?: () => string | undefined
  /** The stored vendor credential for a vendor reader. */
  credentialFor?: (reader: CredentialedWebReaderId) => string | undefined
  /** Readers this host can physically reach (Jina needs a CORS-free transport). */
  hostReachable?: Partial<Record<WebReaderId, boolean>>
  /** False when the host transport cannot recall an in-flight request. */
  transportCancels?: boolean
  admission?: OperationAdmission
  /**
   * Legacy: enable the Jina Reader fallback. Read only when `readerPolicy` is
   * absent.
   */
  jinaFallback?: boolean
  /**
   * Allow fetching private/loopback/link-local hosts. Off by default — the
   * SSRF guard blocks them. Private targets are only ever read directly.
   */
  allowPrivateHosts?: boolean
  /**
   * Legacy: always distill. Read only when `readerPolicy` is absent, where it
   * means `required` distillation (fail closed without a utility model).
   */
  alwaysDistill?: boolean
}

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
const FETCH_EXTRACT_INPUT_MAX = EXTRACTOR_INPUT_MAX_CHARS

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
      maxTokens: EXTRACTOR_OUTPUT_MAX_TOKENS,
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
  /**
   * Host-owned canonical search policy (settings, PII, cache, fallback,
   * filtering, defaults). The host's global defaults live INSIDE the executor
   * at the lowest precedence rung; this module forwards only the caller's
   * explicit fields, so a host fallback value never masquerades as intent.
   */
  searchExecutor?: (
    query: string,
    options: SearchOptions & { provider?: SearchProviderType; allowFallback?: boolean }
  ) => Promise<SearchResponse>
  /**
   * Source-verification settings, read only for the credibility badges. The
   * executor already applied the filtering policy.
   */
  sourceVerification?: SourceVerificationSettings
  /** Cancels the search's adapter requests, retries and fallback. */
  signal?: AbortSignal
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
  if (err instanceof FetchTargetBlockedError) return "blocked"
  if (isSearchCapabilityError(err) || err instanceof SearchDomainPolicyError) {
    return "invalid-arguments"
  }
  return "execution-failed"
}

// Re-exported from `./untrusted-content`, which owns them so that callers
// outside the web stack (the composer's entity mentions, remote-document
// staging) can wrap text without importing the search service and the reader.
export { UNTRUSTED_CONTENT_NOTICE, wrapUntrustedContent } from "./untrusted-content"

/** The policy a host that predates `webReader` gets from its legacy flags. */
function legacyReaderPolicy(deps: WebFetchDeps): ReaderPolicy {
  const jina = deps.jinaFallback === true
  const enabled = new Set<WebReaderId>([
    "direct",
    "platform",
    "fxtwitter",
    ...(jina ? ["jina" as const] : []),
  ])
  const distillation = deps.alwaysDistill === true ? "required" : "off"
  return {
    defaultReader: "auto",
    enabled,
    externalOrder: jina ? ["jina"] : [],
    externalFallback: jina,
    distillation,
    timeoutMs: READ_TOTAL_BUDGET_MS,
    maxAttempts: MAX_OPERATION_ATTEMPTS,
    revision: `legacy|${jina ? "jina" : ""}|${distillation}`,
  }
}

/**
 * Read a URL through the configured Reader and return readable content for
 * the model. See `lib/web/reader/configured-reader.ts` for routing, status and
 * distillation semantics. The success payload carries one `untrustedNotice`.
 */
export async function webFetch(args: WebFetchArgs, deps: WebFetchDeps = {}): Promise<unknown> {
  const request: ReadRequest = { ...args }
  const result = await readWithPolicy(request, {
    policy: deps.readerPolicy ?? legacyReaderPolicy(deps),
    fetchImpl: deps.fetchImpl,
    userAgent: deps.userAgent,
    summarize: deps.summarize,
    signal: deps.signal,
    cache: deps.cache,
    scope: deps.scope,
    activeScope: deps.activeScope,
    allowPrivateHosts: deps.allowPrivateHosts,
    credentialFor: deps.credentialFor,
    hostReachable: deps.hostReachable,
    transportCancels: deps.transportCancels,
    admission: deps.admission,
  })
  // One frame for the whole payload, exactly as `shapeSearchResponse` does it.
  // A structured failure carries no external text, so it needs none.
  if (typeof (result as { status?: unknown }).status === "number") {
    return { ...result, untrustedNotice: UNTRUSTED_CONTENT_NOTICE }
  }
  return result
}

/** Cap `text` at `cap` characters, reporting whether it was cut. */
function bounded(text: unknown, cap: number): { text: string; truncated: boolean } | undefined {
  if (typeof text !== "string") return undefined
  return text.length > cap
    ? { text: text.slice(0, cap) + "…", truncated: true }
    : { text, truncated: false }
}

/**
 * Map a policy-filtered `SearchResponse` into the compact, token-bounded tool
 * result. The executor already applied verification and domain policy
 * (including on cache hits); this only shapes, badges and bounds.
 */
function shapeSearchResponse(
  query: string,
  response: SearchResponse,
  sv: SourceVerificationSettings | undefined,
  excerptChars: number | undefined
): unknown {
  const withBadges = Boolean(sv?.enabled && sv.showVerificationBadges)
  // Defense in depth for executors other than the canonical one: re-apply
  // the verification filter (idempotent) and, if it removes a grounding
  // result, drop the answer it may cite.
  const verified = applySourceVerificationPolicy(response.results, sv)
  const answer = verified.length === response.results.length ? (response.answer ?? null) : null
  const images = (response.images ?? []).slice(0, SEARCH_IMAGES_MAX).map((image) => ({
    url: image.url,
    ...(image.thumbnailUrl ? { thumbnailUrl: image.thumbnailUrl } : {}),
    ...(image.title ? { title: image.title } : {}),
    ...(typeof image.width === "number" ? { width: image.width } : {}),
    ...(typeof image.height === "number" ? { height: image.height } : {}),
  }))
  const diagnostics = response.diagnostics
  return {
    ok: true as const,
    query,
    provider: response.provider,
    // One frame for the whole payload instead of one per field.
    untrustedNotice: UNTRUSTED_CONTENT_NOTICE,
    answer,
    ...(response.searchType ? { searchType: response.searchType } : {}),
    ...(response.engine ? { engine: response.engine } : {}),
    // Structured results only. Each snippet is capped (and says so) so a
    // chatty provider can't blow up the tool-result token cost; the model can
    // `web_fetch` a result URL when it needs the full page.
    results: verified.map((r) => {
      const snippet = bounded(r.content, SEARCH_SNIPPET_MAX_CHARS)
      const excerpt = excerptChars ? bounded(r.rawContent, excerptChars) : undefined
      return {
        title: r.title,
        url: r.url,
        content: snippet?.text ?? r.content,
        ...(snippet?.truncated ? { truncated: true } : {}),
        ...(excerpt
          ? { excerpt: excerpt.text, ...(excerpt.truncated ? { excerptTruncated: true } : {}) }
          : {}),
        score: r.score,
        ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
        ...(withBadges ? { credibility: verifySource(r.url).credibilityLevel } : {}),
      }
    }),
    ...(images.length > 0 ? { images } : {}),
    ...(response.images && response.images.length > SEARCH_IMAGES_MAX
      ? { imagesTruncated: true }
      : {}),
    ...(diagnostics?.answerCleared || (response.answer && answer === null)
      ? { answerCleared: diagnostics?.answerCleared ?? "policy-filtered" }
      : {}),
    ...(diagnostics?.degradedControls?.length
      ? { degradedControls: diagnostics.degradedControls }
      : {}),
    // Credibility badges are a domain heuristic, not fact verification.
    ...(withBadges ? { credibilityBasis: "domain-heuristic" } : {}),
  }
}

/** Multi-provider web search over the user's configured providers. */
export async function webSearch(args: WebSearchArgs, deps: WebSearchDeps = {}): Promise<unknown> {
  const rawQuery = typeof args.query === "string" ? args.query.trim() : ""
  if (!rawQuery) {
    return { ok: false as const, code: "invalid-arguments" as const, error: "query is required" }
  }
  if (!deps.searchExecutor) {
    return {
      ok: false as const,
      code: "no-search-provider" as const,
      error:
        "No web search provider is configured. Enable one and add its API key in Settings → Search.",
    }
  }
  const excerptChars =
    typeof args.excerptChars === "number" && args.excerptChars > 0
      ? Math.min(Math.floor(args.excerptChars), SEARCH_EXCERPT_MAX_CHARS)
      : undefined
  try {
    // Only the caller's EXPLICIT fields travel as overrides. Host defaults
    // (max results, type, depth, …) are folded in by the executor at the
    // lowest rung, beneath each provider's own defaults.
    const response = await deps.searchExecutor(rawQuery, {
      ...(args.provider ? { provider: args.provider } : {}),
      ...(typeof args.maxResults === "number" ? { maxResults: args.maxResults } : {}),
      ...(args.searchType ? { searchType: args.searchType } : {}),
      ...(args.engine ? { engine: args.engine } : {}),
      ...(args.allowFallback === false ? { allowFallback: false } : {}),
      // Snippet-only results never request paid full-content extraction.
      includeRawContent: excerptChars ? "text" : false,
      ...(deps.signal ? { signal: deps.signal } : {}),
    })
    return shapeSearchResponse(
      response.query || rawQuery,
      response,
      deps.sourceVerification,
      excerptChars
    )
  } catch (err) {
    return {
      ok: false as const,
      code: executionFailureCode(err),
      error: err instanceof Error ? err.message : String(err),
      ...(isSearchCapabilityError(err) ? { reason: err.reason } : {}),
      ...(err instanceof SearchDomainPolicyError ? { reason: "domain-policy-conflict" } : {}),
    }
  }
}
