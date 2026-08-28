/**
 * Deep Research's window onto the host's web tools.
 *
 * The plugin owns no provider HTTP, no HTML extraction and no SSRF policy: it
 * calls `ctx.agent.invokeTool("web_search" | "web_fetch", …)` and the host runs
 * the same search-and-read stack the main agent uses — the user's configured
 * providers, the shared result cache, source verification, PII redaction, the
 * SSRF guard and the outbound rate limiter. That is the whole point of the
 * promoted host tools: one policy, not a second weaker copy per plugin.
 *
 * This file is the narrow layer that turns those calls into the engine's
 * `SearchFn` / `ReadFn`: it validates the SDK-typed results and maps host
 * failure codes onto {@link ResearchErrorCode}, so the loop sees engine
 * semantics and never a raw host envelope.
 */
import {
  isPluginHostToolFailure,
  isPluginWebFetchSuccess,
  isPluginWebSearchSuccess,
  pluginWebFetchText,
  unwrapUntrustedContent,
  wrapUntrustedContent,
  type PluginContext,
  type PluginHostToolErrorCode,
  type PluginInvocationOptions,
  type PluginWebFetchInput,
  type PluginWebSearchInput,
} from "@cognia/plugin-sdk"

import { ResearchToolError, type ResearchErrorCode } from "./errors"
import type { ReadFn, SearchFn, SearchHit } from "./types"

/** Max characters of page content kept in the engine's working memory. */
const DEFAULT_READ_MAX = 8_000

/**
 * A search snippet this long is treated as already-read content, skipping the
 * fetch. Measured on the UNWRAPPED text: the untrusted-content banner is ~137
 * characters, and counting it let a two-line snippet masquerade as a page.
 */
const MIN_INLINE_CONTENT = 400

/**
 * Host codes → engine codes. A failure the user can fix (or must be told
 * about) is fatal; a per-page fault is not, so one dead URL cannot end a run.
 */
const FATAL_CODES: Record<string, ResearchErrorCode> = {
  "web-disabled": "WEB_DISABLED",
  "no-search-provider": "NO_SEARCH_PROVIDER",
  "rate-limited": "RATE_LIMITED",
  "not-author-callable": "TOOL_UNAVAILABLE",
}

function toResearchError(
  tool: string,
  code: PluginHostToolErrorCode | undefined,
  message: string,
  { fatalByDefault }: { fatalByDefault: boolean }
): ResearchToolError {
  const mapped = code ? FATAL_CODES[code] : undefined
  if (mapped) return new ResearchToolError(mapped, message, true)
  if (code === "blocked") {
    // A refused target is about THIS url; a refused search is about the query
    // policy. Fatality therefore follows the caller, not the code.
    return new ResearchToolError("BLOCKED", message, fatalByDefault)
  }
  return new ResearchToolError("FAILED", `${tool}: ${message}`, fatalByDefault)
}

interface HostToolOptions {
  /** Session the run belongs to — routes the call to the right credentials. */
  sessionId?: string
  signal?: AbortSignal
  /** Cap on retained page characters. */
  readMaxChars?: number
}

function invocation(options: HostToolOptions): PluginInvocationOptions {
  return {
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }
}

/** Build the engine's search dependency from the host's `web_search`. */
export function makeSearchFn(ctx: PluginContext, options: HostToolOptions = {}): SearchFn {
  return async (query, limit) => {
    const input: PluginWebSearchInput = { query, maxResults: limit }
    const result = await ctx.agent.invokeTool("web_search", input, invocation(options))

    if (isPluginHostToolFailure(result)) {
      // A search that cannot run at all is a precondition failure: continuing
      // would produce a confident answer built on nothing.
      throw toResearchError("web_search", result.code, result.error, { fatalByDefault: true })
    }
    if (!isPluginWebSearchSuccess(result)) {
      throw new ResearchToolError(
        "FAILED",
        "web_search returned an unrecognized result shape",
        true
      )
    }

    return result.results.map((hit): SearchHit => ({
      // Frame every hit as untrusted: titles and snippets are written by
      // whoever owns the page, and they land straight in a model prompt.
      title: wrapUntrustedContent(hit.title || hit.url),
      url: hit.url,
      // Only frame text that exists. Wrapping "" produced a ~137-char banner
      // and nothing else for every snippet-less hit — pure boilerplate carried
      // through the loop's working memory.
      content: hit.content ? wrapUntrustedContent(hit.content) : "",
      score: hit.score ?? 0,
      ...(hit.publishedDate ? { publishedDate: hit.publishedDate } : {}),
    }))
  }
}

/** Build the engine's reader from the host's `web_fetch`. */
export function makeReadFn(ctx: PluginContext, options: HostToolOptions = {}): ReadFn {
  const readMaxChars = options.readMaxChars ?? DEFAULT_READ_MAX

  return async (url, hit) => {
    const inline = hit ? unwrapUntrustedContent(hit.content) : ""
    // A provider that already returned the full text is a free read.
    if (inline.trim().length >= MIN_INLINE_CONTENT) {
      return wrapUntrustedContent(inline.slice(0, readMaxChars))
    }

    const input: PluginWebFetchInput = { url, format: "text", maxBytes: readMaxChars }
    let result: unknown
    try {
      result = await ctx.agent.invokeTool("web_fetch", input, invocation(options))
    } catch (err) {
      // Losing one page is not losing the run — fall back to the snippet.
      if (inline) return wrapUntrustedContent(inline)
      throw toResearchError("web_fetch", undefined, errorMessage(err), { fatalByDefault: false })
    }

    if (isPluginHostToolFailure(result)) {
      const mapped = result.code ? FATAL_CODES[result.code] : undefined
      // `web-disabled` / `rate-limited` are about the whole run, so they must
      // surface even when a usable snippet exists — silently answering from
      // snippets would hide that the reader was never allowed to run.
      if (mapped) throw new ResearchToolError(mapped, result.error, true)
      return inline ? wrapUntrustedContent(inline) : ""
    }
    if (!isPluginWebFetchSuccess(result)) {
      return inline ? wrapUntrustedContent(inline) : ""
    }

    const fetched = unwrapUntrustedContent(pluginWebFetchText(result)).slice(0, readMaxChars)
    const content = fetched || inline
    return content ? wrapUntrustedContent(content) : ""
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
