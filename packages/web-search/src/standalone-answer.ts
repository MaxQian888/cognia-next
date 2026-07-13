// Standalone (BYOK) web search → cited answer — framework-agnostic core.
//
// The multi-provider search runs client-side (`./search-service::search` →
// direct fetch to Tavily/Exa/…) and the answer synthesis runs on a model the
// HOST resolves and injects (`StandaloneAnswerDeps`, ADR-0068 E2's
// `{ model, fetch }` seam). In the app the binding is
// `lib/search/standalone-answer.ts`: it reads the settings store for the
// search-provider keys + result cap, and builds the model via
// `resolveStandaloneProvider` + `createFeatureProviderModel` with
// `getStreamingFetch()` / `browserDirectHeaders()` so the transport behavior
// is exactly the BYOK chat engine's. Other shells (CLI, sidecar) can inject
// their own config/model without touching this module.

import { generateText } from "ai"
import type { LanguageModel } from "ai"

import { search } from "./search-service"
import { getEnabledProviders } from "./types"
import type { SearchProviderSettings, SearchProviderType, SearchResult } from "./types"

/** Stable, i18n-mappable failure codes surfaced to the UI. */
export type StandaloneSearchErrorCode =
  "empty-query" | "no-search-provider" | "no-model-provider" | "search-failed" | "answer-failed"

export class StandaloneSearchError extends Error {
  readonly code: StandaloneSearchErrorCode
  constructor(code: StandaloneSearchErrorCode, message: string) {
    super(message)
    this.name = "StandaloneSearchError"
    this.code = code
  }
}

export interface StandaloneSearchAnswer {
  query: string
  /** Synthesized (or provider-native) cited answer; omitted when neither exists. */
  answer?: string
  sources: SearchResult[]
  /** Search provider that produced the sources. */
  provider: SearchProviderType
  /**
   * True when no BYOK model provider is configured, so the answer (if any)
   * is the search provider's own summary rather than a model synthesis. The
   * UI uses this to nudge the user toward adding a model key.
   */
  modelUnavailable?: boolean
}

export interface RunStandaloneSearchParams {
  query: string
  signal?: AbortSignal
  /** Overrides the host-configured max results. */
  maxResults?: number
  /** Test seam — inject a fake search. */
  searchImpl?: typeof search
  /** Test seam — inject a fake `generateText`. */
  generateTextImpl?: typeof generateText
}

/**
 * Host-injected dependencies (ADR-0068 E2). Both are read lazily per call so
 * the host's live config (e.g. a settings store) is always current.
 */
export interface StandaloneAnswerDeps {
  /** Search-provider settings + default result cap. */
  getConfig: () => {
    providerSettings: Partial<Record<SearchProviderType, SearchProviderSettings>> | undefined
    maxResults?: number
  }
  /**
   * Resolve the BYOK answer-synthesis model (transport/fetch/headers already
   * bound by the host), or `null` when no model provider is configured — the
   * caller then falls back to the search provider's own answer.
   */
  resolveModel: () => LanguageModel | null
}

/** Default number of sources pulled per query when settings don't specify one. */
const DEFAULT_MAX_RESULTS = 8
/** Cap the per-source content fed to the model so the prompt stays bounded. */
const SOURCE_CONTENT_MAX = 1500

const ANSWER_SYSTEM_PROMPT =
  "You are a precise research assistant. Answer the user's question using ONLY the " +
  "numbered web sources provided. Cite every claim with bracketed source numbers like " +
  "[1] or [2][3]. If the sources do not contain the answer, say so plainly. Be concise " +
  "and do not invent sources or facts."

/** Build the grounding prompt from the numbered search results. */
export function buildAnswerPrompt(query: string, results: SearchResult[]): string {
  const blocks = results.map((r, i) => {
    const body = (r.content ?? "").slice(0, SOURCE_CONTENT_MAX)
    return `[${i + 1}] ${r.title}\nURL: ${r.url}\n${body}`.trim()
  })
  return `Question: ${query}\n\nSources:\n${blocks.join("\n\n")}`
}

/**
 * Run a standalone web search and synthesize a cited answer. Throws a
 * `StandaloneSearchError` (with a stable `code`) for every failure mode so the
 * surface can render a localized message. Aborts propagate to the caller.
 */
export async function runStandaloneSearchAnswer(
  params: RunStandaloneSearchParams,
  deps: StandaloneAnswerDeps
): Promise<StandaloneSearchAnswer> {
  const query = params.query.trim()
  if (!query) {
    throw new StandaloneSearchError("empty-query", "Enter a question to search.")
  }

  const config = deps.getConfig()
  const providerSettings = config.providerSettings
  if (!providerSettings || getEnabledProviders(providerSettings).length === 0) {
    throw new StandaloneSearchError(
      "no-search-provider",
      "No web-search provider is enabled. Add a search API key first."
    )
  }

  const runSearch = params.searchImpl ?? search
  const maxResults = params.maxResults ?? config.maxResults ?? DEFAULT_MAX_RESULTS

  let response
  try {
    response = await runSearch(query, {
      providerSettings,
      maxResults,
      includeAnswer: true,
      fallbackEnabled: true,
    })
  } catch (err) {
    throw new StandaloneSearchError(
      "search-failed",
      err instanceof Error ? err.message : String(err)
    )
  }

  const sources = response.results ?? []
  const model = deps.resolveModel()

  // No BYOK model provider: still return the sources plus any answer the search
  // provider itself produced (Tavily/Exa/Brave can include one).
  if (!model) {
    return {
      query,
      answer: response.answer,
      sources,
      provider: response.provider,
      modelUnavailable: true,
    }
  }

  // With sources but a configured model, synthesize a grounded, cited answer.
  try {
    const generate = params.generateTextImpl ?? generateText
    const { text } = await generate({
      model,
      system: ANSWER_SYSTEM_PROMPT,
      prompt: buildAnswerPrompt(query, sources),
      abortSignal: params.signal,
    })
    return {
      query,
      answer: text.trim() || response.answer,
      sources,
      provider: response.provider,
    }
  } catch (err) {
    if (params.signal?.aborted) throw err
    throw new StandaloneSearchError(
      "answer-failed",
      err instanceof Error ? err.message : String(err)
    )
  }
}
