/**
 * Engine-local domain types for the DeepSearch/DeepResearch loop.
 *
 * These deliberately do NOT import `@/types/plugin` or any core module —
 * the engine is a pure, dependency-injected state machine so it can be unit
 * tested in isolation and the whole plugin stays detachable (zero coupling).
 * The plugin glue (`tool.ts` / `slash.ts` / `index.ts`) adapts the host
 * `PluginContext` onto the `EngineDeps` shape defined here.
 */
import type { AiBridge } from "./lib/ai"

/** What the user is asking for. */
export type ResearchMode = "search" | "report"

/** The four primitive moves of the search→read→reason loop (Jina-style). */
export type ResearchAction = "search" | "read" | "reflect" | "answer"

/** Tunable budgets + ceilings. All have sane defaults in `DEFAULT_CONFIG`. */
export interface DeepSearchConfig {
  /** Soft token budget. Past this, the loop enters beast mode and must answer. */
  tokenBudget: number
  /** Hard ceiling on loop iterations. */
  maxSteps: number
  /** How many failed answer attempts before we force a final answer. */
  maxBadAttempts: number
  /** How many URLs to read per read step. */
  readTopK: number
  /** How many results to request per search query. */
  searchResultsPerQuery: number
  /** BCP-47 locale used to bias query rewriting + the final answer language. */
  locale?: string
}

export const DEFAULT_CONFIG: DeepSearchConfig = {
  tokenBudget: 120_000,
  maxSteps: 24,
  maxBadAttempts: 2,
  readTopK: 3,
  searchResultsPerQuery: 6,
}

/** A single search-engine result. */
export interface SearchHit {
  title: string
  url: string
  /** Snippet or provider-supplied raw content (used as a cheap "read"). */
  content: string
  score: number
  publishedDate?: string
}

/** A piece of evidence the loop has accepted into working memory. */
export interface KnowledgeItem {
  url: string
  title: string
  content: string
  /** Which (sub)question this evidence was gathered for, if any. */
  question?: string
}

export interface Citation {
  url: string
  title: string
}

/** One recorded move, surfaced as a progress card. */
export interface ResearchStep {
  step: number
  action: ResearchAction
  detail: string
}

export interface DeepSearchResult {
  answer: string
  citations: Citation[]
  knowledge: KnowledgeItem[]
  steps: ResearchStep[]
  usage: { totalTokens: number }
  /** True when the answer was forced out by budget/step limits, not by passing evaluation. */
  gaveUp: boolean
}

// ── DeepResearch (report layer) ──────────────────────────────────────────────

export interface OutlineSection {
  heading: string
  question: string
}

export interface ResearchOutline {
  title: string
  sections: OutlineSection[]
}

export interface SectionResult {
  heading: string
  question: string
  answer: string
  citations: Citation[]
  gaveUp: boolean
}

export interface DeepResearchResult {
  topic: string
  title: string
  /** Final coherent markdown report. */
  report: string
  outline: ResearchOutline
  sections: SectionResult[]
  /** Deduplicated, aggregated across all sections. */
  citations: Citation[]
  usage: { totalTokens: number }
}

/**
 * Fetch raw search results for a query. Injected so the engine never touches
 * the network directly (the plugin glue wires Exa/Tavily via `fetch`).
 */
export type SearchFn = (query: string, limit: number) => Promise<SearchHit[]>

/**
 * Read the full content behind a URL. `hit` is passed when the URL came from a
 * search result so the implementation can reuse provider-supplied raw content
 * before falling back to an HTTP fetch.
 */
export type ReadFn = (url: string, hit?: SearchHit) => Promise<string>

export interface EngineLogger {
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
}

/** Everything the engine needs, injected. Fully mockable in tests. */
export interface EngineDeps {
  ai: AiBridge
  search: SearchFn
  read: ReadFn
  logger?: EngineLogger
  /** Streamed to the user as progress cards (0..1, message). */
  reportProgress?: (progress: number, message?: string) => void
  signal?: AbortSignal
}
