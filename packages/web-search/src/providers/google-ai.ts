/**
 * Google AI Search Provider (Gemini Grounding with Google Search)
 * Uses Google's Gemini API with grounding capability for real-time web search
 * https://ai.google.dev/gemini-api/docs/google-search
 */

import type { SearchOptions, SearchResponse, SearchResult } from "../types"
import { generateThroughSeam, type GenerationOverrides } from "../generation-seam"
import { googleAIFetch } from "../proxy-search-fetch"
import { log } from "../log"

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models"

export interface GoogleAISearchOptions extends SearchOptions {
  /** Model to use for search (default: gemini-2.0-flash) */
  model?: string
  /** Dynamic retrieval threshold for legacy models (0.0-1.0) */
  dynamicThreshold?: number
  /** Whether to use legacy google_search_retrieval tool (for Gemini 1.5) */
  useLegacyRetrieval?: boolean
}

interface GroundingMetadata {
  webSearchQueries?: string[]
  searchEntryPoint?: { renderedContent: string }
  groundingChunks?: Array<{ web?: { uri: string; title: string } }>
  groundingSupports?: Array<{
    segment: { startIndex: number; endIndex: number; text: string }
    groundingChunkIndices: number[]
  }>
}

interface GeminiResponse {
  candidates?: Array<{
    content: { parts: Array<{ text: string }>; role: string }
    finishReason?: string
    groundingMetadata?: GroundingMetadata
  }>
  usageMetadata?: {
    promptTokenCount: number
    candidatesTokenCount: number
    totalTokenCount: number
    /** Prompt tokens served from a context cache (part of `promptTokenCount`). */
    cachedContentTokenCount?: number
    /** Thinking tokens, billed as output but not part of `candidatesTokenCount`. */
    thoughtsTokenCount?: number
  }
  error?: { code: number; message: string; status: string }
}

function buildRequestBody(query: string, options: GoogleAISearchOptions): Record<string, unknown> {
  const { useLegacyRetrieval = false, dynamicThreshold = 0.7 } = options

  const contents = [{ parts: [{ text: query }] }]

  const tools = useLegacyRetrieval
    ? [
        {
          google_search_retrieval: {
            dynamic_retrieval_config: {
              mode: "MODE_DYNAMIC",
              dynamic_threshold: dynamicThreshold,
            },
          },
        },
      ]
    : [{ google_search: {} }]

  return { contents, tools }
}

function parseGroundingMetadata(metadata: GroundingMetadata | undefined): {
  results: SearchResult[]
  queries: string[]
} {
  if (!metadata) {
    return { results: [], queries: [] }
  }

  const queries = metadata.webSearchQueries || []
  const chunks = metadata.groundingChunks || []
  const supports = metadata.groundingSupports || []

  const chunkScores = new Map<number, number>()
  for (const support of supports) {
    for (const idx of support.groundingChunkIndices) {
      chunkScores.set(idx, (chunkScores.get(idx) || 0) + 1)
    }
  }

  const results: SearchResult[] = []

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]
    if (!chunk.web) continue

    const supportCount = chunkScores.get(index) || 0
    const maxSupports = Math.max(...Array.from(chunkScores.values()), 1)
    const score = supportCount > 0 ? 0.5 + (supportCount / maxSupports) * 0.5 : 0.3

    const relevantSegments = supports
      .filter((s) => s.groundingChunkIndices.includes(index))
      .map((s) => s.segment.text)
      .join(" ")

    let source: string | undefined
    try {
      source = new URL(chunk.web.uri).hostname
    } catch {
      source = undefined
    }

    results.push({
      title: chunk.web.title || "Web Result",
      url: chunk.web.uri,
      content: relevantSegments || `Source: ${chunk.web.title}`,
      score,
      source,
    })
  }

  return { results, queries }
}

export function addInlineCitations(text: string, metadata: GroundingMetadata | undefined): string {
  if (!metadata?.groundingSupports || !metadata?.groundingChunks) {
    return text
  }

  const { groundingSupports: supports, groundingChunks: chunks } = metadata

  const sortedSupports = [...supports].sort(
    (a, b) => (b.segment.endIndex || 0) - (a.segment.endIndex || 0)
  )

  let result = text

  for (const support of sortedSupports) {
    const endIndex = support.segment.endIndex
    if (endIndex === undefined || !support.groundingChunkIndices?.length) {
      continue
    }

    const citationLinks = support.groundingChunkIndices
      .map((i) => {
        const uri = chunks[i]?.web?.uri
        if (uri) return `[${i + 1}](${uri})`
        return null
      })
      .filter(Boolean)

    if (citationLinks.length > 0) {
      const citationString = citationLinks.join(", ")
      if (endIndex <= result.length) {
        result = result.slice(0, endIndex) + citationString + result.slice(endIndex)
      }
    }
  }

  return result
}

function getModelId(options: GoogleAISearchOptions): string {
  if (options.model) {
    return options.model
  }
  return options.useLegacyRetrieval ? "gemini-1.5-flash" : "gemini-2.0-flash"
}

/**
 * The body a ledgered call sends: the reservation's output bound added as
 * `generationConfig.maxOutputTokens`. With no bound it is the body itself.
 */
function withOutputBound(
  body: Record<string, unknown>,
  overrides: GenerationOverrides
): Record<string, unknown> {
  return overrides.maxOutputTokens === undefined
    ? body
    : { ...body, generationConfig: { maxOutputTokens: overrides.maxOutputTokens } }
}

/**
 * Gemini's usage report in the AI SDK's shape, which is what a ledger settles
 * from. The prompt count already includes cached tokens, and thinking tokens
 * are output, so both totals are inclusive like the AI SDK's.
 */
function usageOf(metadata: GeminiResponse["usageMetadata"]): Record<string, number> | undefined {
  if (!metadata) return undefined
  return {
    inputTokens: metadata.promptTokenCount ?? 0,
    outputTokens: (metadata.candidatesTokenCount ?? 0) + (metadata.thoughtsTokenCount ?? 0),
    ...(metadata.cachedContentTokenCount
      ? { cachedInputTokens: metadata.cachedContentTokenCount }
      : {}),
  }
}

/** The first candidate's text, or "" — never throws on a malformed answer; the caller checks that. */
function answerOf(data: GeminiResponse): string {
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ?? ""
}

/**
 * One grounded generation, through the host's generation seam when it injected
 * one (ADR-0188 D27). `request` is the caller's own round trip for a body; it
 * throws on an HTTP or API error exactly as the caller always has. With no seam
 * the body is sent unchanged.
 */
async function runGroundedGeneration(
  query: string,
  modelId: string,
  options: GoogleAISearchOptions,
  request: (body: Record<string, unknown>) => Promise<GeminiResponse>
): Promise<GeminiResponse> {
  const body = buildRequestBody(query, options)
  // Written by `send` (a closure), so it is widened here rather than narrowed to `undefined`.
  let data = undefined as GeminiResponse | undefined
  await generateThroughSeam(
    options.generate,
    { stage: "web-search.google-ai", modelId, prompt: query },
    async (overrides) => {
      const answered = await request(withOutputBound(body, overrides))
      data = answered
      return { text: answerOf(answered), usage: usageOf(answered.usageMetadata) }
    }
  )
  if (!data) {
    throw new Error("Google AI generation seam resolved without sending the request")
  }
  return data
}

export async function searchWithGoogleAI(
  query: string,
  apiKey: string,
  options: GoogleAISearchOptions = {}
): Promise<SearchResponse> {
  if (!apiKey) {
    throw new Error("Google AI API key is required")
  }

  const startTime = Date.now()
  const modelId = getModelId(options)

  try {
    const data = await runGroundedGeneration(query, modelId, options, async (requestBody) => {
      const response = await googleAIFetch(
        `${GEMINI_API_URL}/${modelId}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        }
      )

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMessage = errorData?.error?.message || response.statusText
        throw new Error(`Google AI API error: ${response.status} - ${errorMessage}`)
      }

      const answered: GeminiResponse = await response.json()

      if (answered.error) {
        throw new Error(`Google AI API error: ${answered.error.message}`)
      }
      return answered
    })

    const candidate = data.candidates?.[0]
    if (!candidate) {
      throw new Error("No response from Google AI")
    }

    const answer = candidate.content.parts.map((p) => p.text).join("")

    const { results } = parseGroundingMetadata(candidate.groundingMetadata)

    const maxResults = options.maxResults || 10
    const limitedResults = results.slice(0, maxResults)

    return {
      provider: "google-ai",
      query,
      answer,
      results: limitedResults,
      responseTime: Date.now() - startTime,
      totalResults: results.length,
    }
  } catch (error) {
    log.error("Google AI search error", error)
    throw new Error(
      error instanceof Error
        ? `Google AI search failed: ${error.message}`
        : "Google AI search failed: Unknown error"
    )
  }
}

export async function getGroundedAnswerWithCitations(
  query: string,
  apiKey: string,
  options: GoogleAISearchOptions = {}
): Promise<{ answer: string; citedAnswer: string; sources: SearchResult[] }> {
  if (!apiKey) {
    throw new Error("Google AI API key is required")
  }

  const modelId = getModelId(options)

  const data = await runGroundedGeneration(query, modelId, options, async (requestBody) => {
    const response = await googleAIFetch(
      `${GEMINI_API_URL}/${modelId}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(`Google AI API error: ${errorData?.error?.message || response.statusText}`)
    }

    const answered: GeminiResponse = await response.json()
    return answered
  })
  const candidate = data.candidates?.[0]

  if (!candidate) {
    throw new Error("No response from Google AI")
  }

  const answer = candidate.content.parts.map((p) => p.text).join("")
  const citedAnswer = addInlineCitations(answer, candidate.groundingMetadata)
  const { results: sources } = parseGroundingMetadata(candidate.groundingMetadata)

  return { answer, citedAnswer, sources }
}

/**
 * A user-initiated key probe: it tests this one key on purpose, so it never
 * takes a generation seam — a ledger or route in the way would defeat it (the
 * named provider-diagnostic exemption of ADR-0188 D27).
 */
export async function testGoogleAIConnection(apiKey: string): Promise<boolean> {
  try {
    await searchWithGoogleAI("test connection", apiKey, { maxResults: 1 })
    return true
  } catch {
    return false
  }
}

export function supportsGoogleSearchGrounding(modelId: string): boolean {
  const supportedModels = [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ]

  return supportedModels.some((m) => modelId.toLowerCase().includes(m.toLowerCase()))
}

export function shouldUseLegacyRetrieval(modelId: string): boolean {
  return modelId.includes("1.5")
}
