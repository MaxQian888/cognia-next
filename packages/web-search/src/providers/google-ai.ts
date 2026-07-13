/**
 * Google AI Search Provider (Gemini Grounding with Google Search)
 * Uses Google's Gemini API with grounding capability for real-time web search
 * https://ai.google.dev/gemini-api/docs/google-search
 */

import type { SearchOptions, SearchResponse, SearchResult } from "../types"
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
  const requestBody = buildRequestBody(query, options)

  try {
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

    const data: GeminiResponse = await response.json()

    if (data.error) {
      throw new Error(`Google AI API error: ${data.error.message}`)
    }

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
  const requestBody = buildRequestBody(query, options)

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

  const data: GeminiResponse = await response.json()
  const candidate = data.candidates?.[0]

  if (!candidate) {
    throw new Error("No response from Google AI")
  }

  const answer = candidate.content.parts.map((p) => p.text).join("")
  const citedAnswer = addInlineCitations(answer, candidate.groundingMetadata)
  const { results: sources } = parseGroundingMetadata(candidate.groundingMetadata)

  return { answer, citedAnswer, sources }
}

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
