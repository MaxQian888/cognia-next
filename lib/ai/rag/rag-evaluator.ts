/**
 * RAG Evaluator — Quality Metrics
 *
 * Provides evaluation metrics for RAG pipeline quality:
 * - Context Precision: Are retrieved chunks relevant?
 * - Context Recall: Are all needed chunks retrieved?
 * - Faithfulness: Is the answer grounded in context?
 * - Answer Relevance: Does the answer address the query?
 *
 * Supports both heuristic (fast, no LLM) and LLM-based evaluation.
 */

import type { LanguageModel } from "ai"
import { generateText } from "ai"
import type { RerankResult } from "./reranker"
import { loggers } from "@/lib/logger"

const log = loggers.ai

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RAGEvaluationConfig {
  /** Use LLM for evaluation (more accurate, slower) */
  useLLM: boolean
  /** LLM model for evaluation */
  model?: LanguageModel
}

export interface RAGEvaluationResult {
  /** Precision of retrieved context (0-1): what fraction of chunks are relevant */
  contextPrecision: number
  /** Estimated recall (0-1): how well the context covers the query */
  contextRecall: number
  /** Faithfulness (0-1): is the answer grounded in context */
  faithfulness: number
  /** Answer relevance (0-1): does the answer address the query */
  answerRelevance: number
  /** Overall quality score (0-1) */
  overallScore: number
  /** Per-metric details */
  details: {
    relevantChunks: number
    totalChunks: number
    queryTermsCovered: number
    queryTermsTotal: number
    supportedSentences: number
    totalSentences: number
  }
}

// ---------------------------------------------------------------------------
// Heuristic Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate context precision: what fraction of retrieved chunks are relevant to the query.
 */
export function evaluateContextPrecision(query: string, documents: RerankResult[]): number {
  if (documents.length === 0) return 0

  const queryTerms = query
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)

  if (queryTerms.length === 0) return 1

  let relevantCount = 0
  for (const doc of documents) {
    const contentLower = doc.content.toLowerCase()
    let matchCount = 0
    for (const term of queryTerms) {
      if (contentLower.includes(term)) matchCount++
    }
    // A chunk is "relevant" if it matches at least 30% of query terms
    if (matchCount / queryTerms.length >= 0.3) {
      relevantCount++
    }
  }

  return relevantCount / documents.length
}

/**
 * Evaluate context recall: how well the retrieved context covers the query.
 * Measures what fraction of query terms appear in at least one chunk.
 */
export function evaluateContextRecall(
  query: string,
  documents: RerankResult[]
): { recall: number; termsCovered: number; termsTotal: number } {
  const queryTerms = query
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)

  if (queryTerms.length === 0) return { recall: 1, termsCovered: 0, termsTotal: 0 }

  const allContent = documents.map((d) => d.content.toLowerCase()).join(" ")
  let covered = 0
  for (const term of queryTerms) {
    if (allContent.includes(term)) covered++
  }

  return {
    recall: covered / queryTerms.length,
    termsCovered: covered,
    termsTotal: queryTerms.length,
  }
}

/**
 * Evaluate faithfulness: check if the answer's claims are supported by the context.
 */
export function evaluateFaithfulness(
  answer: string,
  context: string
): { faithfulness: number; supportedSentences: number; totalSentences: number } {
  if (!answer || !context) return { faithfulness: 0, supportedSentences: 0, totalSentences: 0 }

  const sentences = answer
    .split(/(?<=[.!?。！？\n])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10)

  if (sentences.length === 0) return { faithfulness: 1, supportedSentences: 0, totalSentences: 0 }

  const contextLower = context.toLowerCase()
  let supported = 0

  for (const sentence of sentences) {
    const terms = sentence
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2)

    if (terms.length === 0) {
      supported++
      continue
    }

    let matchCount = 0
    for (const term of terms) {
      if (contextLower.includes(term)) matchCount++
    }

    if (terms.length > 0 && matchCount / terms.length >= 0.3) {
      supported++
    }
  }

  return {
    faithfulness: supported / sentences.length,
    supportedSentences: supported,
    totalSentences: sentences.length,
  }
}

/**
 * Evaluate answer relevance: does the answer address the query.
 */
export function evaluateAnswerRelevance(query: string, answer: string): number {
  if (!query || !answer) return 0

  const queryTerms = query
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)

  if (queryTerms.length === 0) return 1

  const answerLower = answer.toLowerCase()
  let matched = 0
  for (const term of queryTerms) {
    if (answerLower.includes(term)) matched++
  }

  return matched / queryTerms.length
}

// ---------------------------------------------------------------------------
// LLM-based Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate RAG quality using an LLM judge.
 */
async function evaluateWithLLM(
  query: string,
  context: string,
  answer: string,
  model: LanguageModel
): Promise<Partial<RAGEvaluationResult>> {
  try {
    const prompt = `You are a RAG quality evaluator. Rate the following on a scale of 0-10:

Query: "${query}"

Retrieved Context:
"""
${context.slice(0, 3000)}
"""

Generated Answer:
"""
${answer.slice(0, 2000)}
"""

Rate each metric:
1. Context Precision: Are the retrieved chunks relevant to the query?
2. Context Recall: Does the context contain the information needed to answer?
3. Faithfulness: Is the answer supported by the context (no hallucination)?
4. Answer Relevance: Does the answer address the query?

Respond in this exact format:
PRECISION: <0-10>
RECALL: <0-10>
FAITHFULNESS: <0-10>
RELEVANCE: <0-10>`

    const result = await generateText({
      model,
      prompt,
      temperature: 0,
    })

    const text = result.text
    const parse = (key: string): number => {
      const match = text.match(new RegExp(`${key}:\\s*(\\d+(?:\\.\\d+)?)`, "i"))
      return match ? Math.min(1, parseFloat(match[1]) / 10) : 0.5
    }

    return {
      contextPrecision: parse("PRECISION"),
      contextRecall: parse("RECALL"),
      faithfulness: parse("FAITHFULNESS"),
      answerRelevance: parse("RELEVANCE"),
    }
  } catch (error) {
    log.warn("LLM evaluation failed", { error: String(error) })
    return {}
  }
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Run comprehensive RAG evaluation on a query-context-answer triple.
 */
export async function evaluateRAG(
  query: string,
  context: string,
  answer: string,
  documents: RerankResult[],
  config: Partial<RAGEvaluationConfig> = {}
): Promise<RAGEvaluationResult> {
  // Heuristic evaluation
  const precision = evaluateContextPrecision(query, documents)
  const recallResult = evaluateContextRecall(query, documents)
  const faithResult = evaluateFaithfulness(answer, context)
  const relevance = evaluateAnswerRelevance(query, answer)

  let result: RAGEvaluationResult = {
    contextPrecision: precision,
    contextRecall: recallResult.recall,
    faithfulness: faithResult.faithfulness,
    answerRelevance: relevance,
    overallScore: 0,
    details: {
      relevantChunks: Math.round(precision * documents.length),
      totalChunks: documents.length,
      queryTermsCovered: recallResult.termsCovered,
      queryTermsTotal: recallResult.termsTotal,
      supportedSentences: faithResult.supportedSentences,
      totalSentences: faithResult.totalSentences,
    },
  }

  // Override with LLM evaluation if enabled
  if (config.useLLM && config.model) {
    const llmResult = await evaluateWithLLM(query, context, answer, config.model)
    result = {
      ...result,
      ...(llmResult.contextPrecision !== undefined
        ? { contextPrecision: llmResult.contextPrecision }
        : {}),
      ...(llmResult.contextRecall !== undefined ? { contextRecall: llmResult.contextRecall } : {}),
      ...(llmResult.faithfulness !== undefined ? { faithfulness: llmResult.faithfulness } : {}),
      ...(llmResult.answerRelevance !== undefined
        ? { answerRelevance: llmResult.answerRelevance }
        : {}),
    }
  }

  // Weighted overall score
  result.overallScore =
    result.contextPrecision * 0.25 +
    result.contextRecall * 0.25 +
    result.faithfulness * 0.3 +
    result.answerRelevance * 0.2

  return result
}
