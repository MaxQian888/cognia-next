/**
 * Retrieval Grader — Corrective RAG (CRAG)
 *
 * Grades retrieved documents for relevance before passing them to the LLM.
 * Filters out irrelevant chunks and optionally triggers fallback strategies
 * when retrieval quality is too low.
 *
 * Strategies:
 * - Heuristic grading: term overlap, position, metadata match
 * - LLM grading: prompt-based relevance scoring
 * - Fallback: query reformulation or graceful degradation
 */

import type { LanguageModel } from "ai"
import { generateText } from "ai"
import type { RerankResult } from "./reranker"
import { getRAGLogger } from "./runtime-adapters"

const log = getRAGLogger()

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrievalGraderConfig {
  /** Minimum grade (0-1) for a chunk to be considered relevant */
  relevanceThreshold: number
  /** Use LLM for grading (more accurate but slower) */
  useLLM: boolean
  /** LLM model for grading (required if useLLM=true) */
  model?: LanguageModel
  /** Fallback strategy when too few chunks pass grading */
  fallbackStrategy: "none" | "relax_threshold" | "keep_best"
  /** Minimum number of chunks to keep even if below threshold */
  minChunks: number
  /** Maximum number of chunks to grade (for performance) */
  maxChunksToGrade: number
}

export interface GradedDocument {
  /** Original document */
  document: RerankResult
  /** Relevance grade 0-1 */
  grade: number
  /** Whether the document passed the threshold */
  relevant: boolean
  /** Grading method used */
  method: "heuristic" | "llm"
  /** Explanation of the grade (from LLM grading) */
  explanation?: string
}

export interface GradingResult {
  /** All graded documents (including irrelevant ones) */
  allDocuments: GradedDocument[]
  /** Only the documents that passed grading */
  relevantDocuments: RerankResult[]
  /** Statistics */
  stats: {
    totalGraded: number
    totalRelevant: number
    totalFiltered: number
    averageGrade: number
    fallbackUsed: boolean
    method: "heuristic" | "llm"
  }
}

const DEFAULT_CONFIG: RetrievalGraderConfig = {
  relevanceThreshold: 0.4,
  useLLM: false,
  fallbackStrategy: "keep_best",
  minChunks: 1,
  maxChunksToGrade: 20,
}

// ---------------------------------------------------------------------------
// Heuristic Grading
// ---------------------------------------------------------------------------

/**
 * Grade a document's relevance to a query using heuristics.
 * Combines term overlap, exact phrase match, and metadata signals.
 */
export function gradeDocumentHeuristic(query: string, document: RerankResult): number {
  const queryLower = query.toLowerCase()
  const contentLower = document.content.toLowerCase()

  // 1. Term overlap score (0-1)
  const queryTerms = queryLower
    .replace(/[^\w\s\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)

  if (queryTerms.length === 0) return 0.5 // Neutral for empty queries

  let matchedTerms = 0
  for (const term of queryTerms) {
    if (contentLower.includes(term)) {
      matchedTerms++
    }
  }
  const termOverlap = queryTerms.length > 0 ? matchedTerms / queryTerms.length : 0

  // 2. Exact phrase match bonus
  const phraseBonus = contentLower.includes(queryLower) ? 0.2 : 0

  // 3. Content length penalty (very short chunks are likely low-quality)
  const lengthPenalty = document.content.length < 50 ? -0.1 : 0

  // 4. Rerank score integration (the pipeline already scored this)
  const rerankBoost = Math.min(document.rerankScore * 0.3, 0.3)

  // 5. Metadata title match bonus
  let metadataBonus = 0
  if (document.metadata?.title) {
    const titleLower = String(document.metadata.title).toLowerCase()
    for (const term of queryTerms) {
      if (titleLower.includes(term)) {
        metadataBonus += 0.05
      }
    }
    metadataBonus = Math.min(metadataBonus, 0.15)
  }

  // Combine scores (clamped to 0-1)
  const rawGrade = termOverlap * 0.4 + rerankBoost + phraseBonus + lengthPenalty + metadataBonus
  return Math.max(0, Math.min(1, rawGrade))
}

// ---------------------------------------------------------------------------
// LLM Grading
// ---------------------------------------------------------------------------

/**
 * Grade a document's relevance using an LLM judge.
 */
export async function gradeDocumentLLM(
  query: string,
  document: RerankResult,
  model: LanguageModel
): Promise<{ grade: number; explanation: string }> {
  try {
    const prompt = `You are a relevance grader. Given a user query and a retrieved document, determine if the document is relevant to answering the query.

Query: "${query}"

Document:
"""
${document.content.slice(0, 2000)}
"""

Rate the relevance on a scale of 0 to 10, where:
- 0-2: Not relevant at all
- 3-4: Slightly relevant but not useful
- 5-6: Somewhat relevant
- 7-8: Relevant and useful
- 9-10: Highly relevant and directly answers the query

Respond in this exact format:
SCORE: <number>
REASON: <one sentence explanation>`

    const result = await generateText({
      model,
      prompt,
      temperature: 0,
    })

    const text = result.text.trim()
    const scoreMatch = text.match(/SCORE:\s*(\d+(?:\.\d+)?)/i)
    const reasonMatch = text.match(/REASON:\s*(.+)/i)

    const score = scoreMatch ? parseFloat(scoreMatch[1]) / 10 : 0.5
    const explanation = reasonMatch ? reasonMatch[1].trim() : ""

    return {
      grade: Math.max(0, Math.min(1, score)),
      explanation,
    }
  } catch (error) {
    log.warn("LLM grading failed, falling back to heuristic", { error: String(error) })
    return {
      grade: gradeDocumentHeuristic(query, document),
      explanation: "LLM grading failed, used heuristic fallback",
    }
  }
}

// ---------------------------------------------------------------------------
// Main Grading Function
// ---------------------------------------------------------------------------

/**
 * Grade retrieved documents for relevance (Corrective RAG).
 * Filters out irrelevant chunks before they reach the LLM.
 */
export async function gradeRetrievedDocuments(
  query: string,
  documents: RerankResult[],
  config: Partial<RetrievalGraderConfig> = {}
): Promise<GradingResult> {
  const cfg: RetrievalGraderConfig = { ...DEFAULT_CONFIG, ...config }

  // Limit number of documents to grade
  const docsToGrade = documents.slice(0, cfg.maxChunksToGrade)
  const method: "heuristic" | "llm" = cfg.useLLM && cfg.model ? "llm" : "heuristic"

  // Grade each document
  const graded: GradedDocument[] = []

  for (const doc of docsToGrade) {
    if (method === "llm" && cfg.model) {
      const llmResult = await gradeDocumentLLM(query, doc, cfg.model)
      graded.push({
        document: doc,
        grade: llmResult.grade,
        relevant: llmResult.grade >= cfg.relevanceThreshold,
        method: "llm",
        explanation: llmResult.explanation,
      })
    } else {
      const grade = gradeDocumentHeuristic(query, doc)
      graded.push({
        document: doc,
        grade,
        relevant: grade >= cfg.relevanceThreshold,
        method: "heuristic",
      })
    }
  }

  // Collect relevant documents
  let relevantDocs = graded
    .filter((g) => g.relevant)
    .sort((a, b) => b.grade - a.grade)
    .map((g) => g.document)

  // Apply fallback strategy if too few results
  let fallbackUsed = false
  if (relevantDocs.length < cfg.minChunks && docsToGrade.length > 0) {
    fallbackUsed = true

    switch (cfg.fallbackStrategy) {
      case "relax_threshold": {
        // Relax threshold by 50%
        const relaxedThreshold = cfg.relevanceThreshold * 0.5
        relevantDocs = graded
          .filter((g) => g.grade >= relaxedThreshold)
          .sort((a, b) => b.grade - a.grade)
          .map((g) => g.document)
        break
      }
      case "keep_best": {
        // Keep at least minChunks documents regardless of grade
        relevantDocs = graded
          .sort((a, b) => b.grade - a.grade)
          .slice(0, cfg.minChunks)
          .map((g) => g.document)
        break
      }
      case "none":
      default:
        // No fallback — return empty if nothing passes
        break
    }
  }

  // Compute stats
  const totalGrade = graded.reduce((sum, g) => sum + g.grade, 0)

  return {
    allDocuments: graded,
    relevantDocuments: relevantDocs,
    stats: {
      totalGraded: graded.length,
      totalRelevant: relevantDocs.length,
      totalFiltered: graded.length - relevantDocs.length,
      averageGrade: graded.length > 0 ? totalGrade / graded.length : 0,
      fallbackUsed,
      method,
    },
  }
}

/**
 * Quick check whether retrieval quality is sufficient.
 * Returns true if at least `minRelevant` chunks score above `threshold`.
 */
export function isRetrievalSufficient(
  query: string,
  documents: RerankResult[],
  options: { threshold?: number; minRelevant?: number } = {}
): boolean {
  const { threshold = 0.4, minRelevant = 1 } = options
  let count = 0
  for (const doc of documents) {
    if (gradeDocumentHeuristic(query, doc) >= threshold) {
      count++
      if (count >= minRelevant) return true
    }
  }
  return false
}
