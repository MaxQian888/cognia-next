/**
 * Reranking Module
 *
 * Implements various reranking strategies to improve retrieval quality:
 * - Cross-encoder reranking (using LLM)
 * - Cohere reranking API
 * - Lightweight scoring heuristics
 * - Maximal Marginal Relevance (MMR) for diversity
 */

import type { LanguageModel } from "ai"
import { cosineSimilarity } from "@cognia/provider-embedding/embedding"
import { getRAGLogger, proxyFetch } from "./runtime-adapters"

const log = getRAGLogger()

export interface RerankDocument {
  id: string
  content: string
  metadata?: Record<string, unknown>
  score?: number
}

export interface RerankResult {
  id: string
  content: string
  metadata?: Record<string, unknown>
  originalScore?: number
  rerankScore: number
  relevanceExplanation?: string
}

export interface RerankConfig {
  model?: LanguageModel
  topN?: number
  batchSize?: number
  cohereApiKey?: string
  cohereModel?: string
  useMMR?: boolean
  mmrLambda?: number // Diversity parameter (0=max diversity, 1=max relevance)
}

/**
 * LLM-based Cross-Encoder Reranker
 * Uses the language model to score relevance of each document to the query
 */
export async function rerankWithLLM(
  query: string,
  documents: RerankDocument[],
  model: LanguageModel,
  options: {
    topN?: number
    includeExplanation?: boolean
  } = {}
): Promise<RerankResult[]> {
  const { topN = 5, includeExplanation = false } = options

  if (documents.length === 0) return []

  const { generateText } = await import("ai")

  const scoringPrompt = includeExplanation
    ? `You are a relevance scoring assistant. Score how relevant each document is to the query on a scale of 0-10, where 0 is completely irrelevant and 10 is perfectly relevant.

Query: "${query}"

For each document, provide a JSON object with:
- "id": the document ID
- "score": relevance score (0-10)
- "explanation": brief reason for the score

Documents to score:
${documents.map((doc, i) => `[${i}] ID: ${doc.id}\nContent: ${doc.content.slice(0, 500)}${doc.content.length > 500 ? "..." : ""}`).join("\n\n")}

Respond with a JSON array of scoring objects. Only output valid JSON, no other text.`
    : `Score the relevance of each document to the query on a scale of 0-10.

Query: "${query}"

Documents:
${documents.map((doc, i) => `[${i}] ID: ${doc.id} | ${doc.content.slice(0, 300)}${doc.content.length > 300 ? "..." : ""}`).join("\n")}

Respond with only a JSON array like: [{"id": "doc1", "score": 8}, {"id": "doc2", "score": 5}]`

  try {
    const result = await generateText({
      model,
      prompt: scoringPrompt,
      temperature: 0.1,
    })

    // Parse the JSON response
    const jsonMatch = result.text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      log.warn("Failed to parse reranking response, returning original order")
      return documents.map((doc) => ({
        id: doc.id,
        content: doc.content,
        metadata: doc.metadata,
        originalScore: doc.score,
        rerankScore: doc.score || 0,
      }))
    }

    const scores: { id: string; score: number; explanation?: string }[] = JSON.parse(jsonMatch[0])
    const scoreMap = new Map(scores.map((s) => [s.id, s]))

    // Build results with scores
    const results: RerankResult[] = documents.map((doc) => {
      const scoreInfo = scoreMap.get(doc.id)
      return {
        id: doc.id,
        content: doc.content,
        metadata: doc.metadata,
        originalScore: doc.score,
        rerankScore: scoreInfo?.score ?? (doc.score || 0),
        relevanceExplanation: scoreInfo?.explanation,
      }
    })

    // Sort by rerank score and take topN
    return results.sort((a, b) => b.rerankScore - a.rerankScore).slice(0, topN)
  } catch (error) {
    log.error("LLM reranking failed", error as Error)
    // Fallback to original scores
    return documents
      .map((doc) => ({
        id: doc.id,
        content: doc.content,
        metadata: doc.metadata,
        originalScore: doc.score,
        rerankScore: doc.score || 0,
      }))
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, topN)
  }
}

/**
 * Cohere Rerank API integration
 */
export async function rerankWithCohere(
  query: string,
  documents: RerankDocument[],
  apiKey: string,
  options: {
    model?: string
    topN?: number
  } = {}
): Promise<RerankResult[]> {
  const { model = "rerank-english-v3.0", topN = 5 } = options

  if (documents.length === 0) return []

  try {
    const response = await proxyFetch("https://api.cohere.ai/v1/rerank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        query,
        documents: documents.map((doc) => doc.content),
        top_n: topN,
        return_documents: false,
      }),
    })

    if (!response.ok) {
      throw new Error(`Cohere API error: ${response.statusText}`)
    }

    const data = (await response.json()) as {
      results: { index: number; relevance_score: number }[]
    }

    // Map results back to documents
    return data.results.map((result) => {
      const doc = documents[result.index]
      return {
        id: doc.id,
        content: doc.content,
        metadata: doc.metadata,
        originalScore: doc.score,
        rerankScore: result.relevance_score,
      }
    })
  } catch (error) {
    log.error("Cohere reranking failed", error as Error)
    // Fallback to original order
    return documents
      .map((doc) => ({
        id: doc.id,
        content: doc.content,
        metadata: doc.metadata,
        originalScore: doc.score,
        rerankScore: doc.score || 0,
      }))
      .slice(0, topN)
  }
}

/**
 * Lightweight heuristic-based reranking
 * Uses text matching signals without requiring an API
 */
export function rerankWithHeuristics(
  query: string,
  documents: RerankDocument[],
  options: {
    topN?: number
    weights?: {
      exactMatch?: number
      termOverlap?: number
      positionBoost?: number
      lengthPenalty?: number
    }
  } = {}
): RerankResult[] {
  const { topN = 5 } = options
  const weights = {
    exactMatch: options.weights?.exactMatch ?? 0.4,
    termOverlap: options.weights?.termOverlap ?? 0.3,
    positionBoost: options.weights?.positionBoost ?? 0.2,
    lengthPenalty: options.weights?.lengthPenalty ?? 0.1,
  }

  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2)
  const queryLower = query.toLowerCase()

  const scored = documents.map((doc, index) => {
    const contentLower = doc.content.toLowerCase()
    let score = doc.score || 0

    // Exact query match bonus
    if (contentLower.includes(queryLower)) {
      score += weights.exactMatch * 10
    }

    // Term overlap score
    const contentTerms = new Set(contentLower.split(/\s+/))
    const overlap = queryTerms.filter((t) => contentTerms.has(t)).length
    const overlapRatio = queryTerms.length > 0 ? overlap / queryTerms.length : 0
    score += weights.termOverlap * overlapRatio * 10

    // Position boost (earlier matches are better)
    for (const term of queryTerms) {
      const pos = contentLower.indexOf(term)
      if (pos !== -1) {
        const positionScore = 1 - Math.min(pos / 500, 1)
        score += weights.positionBoost * positionScore
      }
    }

    // Length penalty (prefer concise, relevant content)
    const idealLength = 500
    const lengthDiff = Math.abs(doc.content.length - idealLength)
    const lengthScore = 1 - Math.min(lengthDiff / 2000, 0.5)
    score += weights.lengthPenalty * lengthScore

    return {
      id: doc.id,
      content: doc.content,
      metadata: doc.metadata,
      originalScore: doc.score,
      rerankScore: score,
      originalIndex: index,
    }
  })

  return scored
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .slice(0, topN)
    .map(({ originalIndex: _, ...rest }) => rest)
}

/**
 * Maximal Marginal Relevance (MMR) for diverse reranking
 * Balances relevance with diversity to reduce redundancy
 */
export function rerankWithMMR(
  documents: RerankDocument[],
  queryEmbedding: number[],
  documentEmbeddings: Map<string, number[]>,
  options: {
    topN?: number
    lambda?: number // 0 = max diversity, 1 = max relevance
  } = {}
): RerankResult[] {
  const { topN = 5, lambda = 0.7 } = options

  if (documents.length === 0) return []

  // Using the package-local embedding cosine similarity helper.
  const selected: RerankResult[] = []
  const remaining = [...documents]

  while (selected.length < topN && remaining.length > 0) {
    let bestIdx = -1
    let bestScore = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const doc = remaining[i]
      const docEmbedding = documentEmbeddings.get(doc.id)

      if (!docEmbedding) continue

      // Relevance to query
      const relevance = cosineSimilarity(queryEmbedding, docEmbedding)

      // Maximum similarity to already selected documents
      let maxSimilarity = 0
      for (const selectedDoc of selected) {
        const selectedEmbedding = documentEmbeddings.get(selectedDoc.id)
        if (selectedEmbedding) {
          const sim = cosineSimilarity(docEmbedding, selectedEmbedding)
          maxSimilarity = Math.max(maxSimilarity, sim)
        }
      }

      // MMR score
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity

      if (mmrScore > bestScore) {
        bestScore = mmrScore
        bestIdx = i
      }
    }

    if (bestIdx === -1) break

    const selectedDoc = remaining[bestIdx]
    selected.push({
      id: selectedDoc.id,
      content: selectedDoc.content,
      metadata: selectedDoc.metadata,
      originalScore: selectedDoc.score,
      rerankScore: bestScore,
    })

    remaining.splice(bestIdx, 1)
  }

  return selected
}

/**
 * Combined reranking pipeline
 * Applies multiple reranking strategies in sequence
 */
export async function rerank(
  query: string,
  documents: RerankDocument[],
  config: RerankConfig = {}
): Promise<RerankResult[]> {
  const { topN = 5 } = config

  if (documents.length === 0) return []

  let results: RerankResult[]

  // Choose reranking strategy based on configuration
  if (config.cohereApiKey) {
    // Use Cohere API for reranking
    results = await rerankWithCohere(query, documents, config.cohereApiKey, {
      model: config.cohereModel,
      topN: topN * 2, // Get more for potential MMR
    })
  } else if (config.model) {
    // Use LLM for reranking
    results = await rerankWithLLM(query, documents, config.model, {
      topN: topN * 2,
    })
  } else {
    // Use heuristic reranking
    results = rerankWithHeuristics(query, documents, {
      topN: topN * 2,
    })
  }

  // Apply MMR for diversity if enabled (requires embeddings)
  // Note: MMR integration would need embeddings passed in

  return results.slice(0, topN)
}

/**
 * Filter results by relevance threshold
 */
export function filterByRelevance(results: RerankResult[], minScore: number): RerankResult[] {
  return results.filter((r) => r.rerankScore >= minScore)
}

/**
 * Boost results based on metadata criteria
 */
export function boostByMetadata(
  results: RerankResult[],
  boostCriteria: {
    field: string
    value: unknown
    boost: number
  }[]
): RerankResult[] {
  return results
    .map((result) => {
      let boostedScore = result.rerankScore

      for (const criteria of boostCriteria) {
        if (result.metadata?.[criteria.field] === criteria.value) {
          boostedScore *= criteria.boost
        }
      }

      return {
        ...result,
        rerankScore: boostedScore,
      }
    })
    .sort((a, b) => b.rerankScore - a.rerankScore)
}

/**
 * Recency boost for time-sensitive content
 */
export function boostByRecency(
  results: RerankResult[],
  options: {
    dateField?: string
    maxAgeHours?: number
    boostFactor?: number
  } = {}
): RerankResult[] {
  const { dateField = "createdAt", maxAgeHours = 24 * 30, boostFactor = 1.5 } = options
  const now = Date.now()
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000

  return results
    .map((result) => {
      const dateValue = result.metadata?.[dateField]
      if (!dateValue) return result

      const timestamp =
        typeof dateValue === "number" ? dateValue : new Date(String(dateValue)).getTime()

      if (isNaN(timestamp)) return result

      const age = now - timestamp
      if (age < 0 || age > maxAgeMs) return result

      const recencyBoost = 1 + (1 - age / maxAgeMs) * (boostFactor - 1)

      return {
        ...result,
        rerankScore: result.rerankScore * recencyBoost,
      }
    })
    .sort((a, b) => b.rerankScore - a.rerankScore)
}
