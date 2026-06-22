/**
 * Answer Grounding Check — Self-Reflective RAG
 *
 * Verifies whether a generated answer is grounded in the retrieved context.
 * Detects hallucinations and unsupported claims.
 *
 * Strategies:
 * - Heuristic: sentence-level term overlap and containment checks
 * - LLM: prompt-based grounding evaluation
 */

import type { LanguageModel } from "ai"
import { generateText } from "ai"
import { getRAGLogger } from "./runtime-adapters"

const log = getRAGLogger()

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GroundingCheckConfig {
  /** Use LLM for grounding check (more accurate but slower) */
  useLLM: boolean
  /** LLM model for grounding check */
  model?: LanguageModel
  /** Minimum grounding confidence to consider the answer grounded (0-1) */
  confidenceThreshold: number
  /** Maximum answer length to check (characters) */
  maxAnswerLength: number
  /** Maximum context length to consider (characters) */
  maxContextLength: number
}

export interface GroundingCheckResult {
  /** Whether the answer is considered grounded in the context */
  isGrounded: boolean
  /** Overall confidence score (0-1) */
  confidence: number
  /** Claims in the answer that are supported by context */
  supportedClaims: string[]
  /** Claims in the answer that are NOT supported by context */
  unsupportedClaims: string[]
  /** Method used for checking */
  method: "heuristic" | "llm"
  /** Summary explanation */
  explanation: string
}

const DEFAULT_CONFIG: GroundingCheckConfig = {
  useLLM: false,
  confidenceThreshold: 0.6,
  maxAnswerLength: 5000,
  maxContextLength: 10000,
}

// ---------------------------------------------------------------------------
// Heuristic Grounding Check
// ---------------------------------------------------------------------------

/**
 * Split text into sentences (handles English, Chinese, etc.)
 */
function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation including CJK
  const sentences = text
    .split(/(?<=[.!?。！？\n])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10)
  return sentences
}

/**
 * Calculate term overlap between two texts (0-1)
 */
function termOverlap(textA: string, textB: string): number {
  const normalize = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)

  const termsA = new Set(normalize(textA))
  const termsB = new Set(normalize(textB))

  if (termsA.size === 0) return 0

  let overlap = 0
  for (const term of termsA) {
    if (termsB.has(term)) overlap++
  }
  return overlap / termsA.size
}

/**
 * Check answer grounding using heuristics.
 * Splits the answer into sentences and checks how many are "supported"
 * by term overlap with the context.
 */
export function checkGroundingHeuristic(answer: string, context: string): GroundingCheckResult {
  const sentences = splitSentences(answer)

  if (sentences.length === 0) {
    return {
      isGrounded: true,
      confidence: 1,
      supportedClaims: [],
      unsupportedClaims: [],
      method: "heuristic",
      explanation: "No verifiable claims found in the answer.",
    }
  }

  const supported: string[] = []
  const unsupported: string[] = []

  // Threshold for a sentence to be considered "supported"
  const OVERLAP_THRESHOLD = 0.3

  for (const sentence of sentences) {
    // Skip very generic sentences (greetings, meta-statements)
    if (/^(yes|no|sure|okay|here|based on|according to|the answer is)/i.test(sentence)) {
      supported.push(sentence)
      continue
    }

    const overlap = termOverlap(sentence, context)
    if (overlap >= OVERLAP_THRESHOLD) {
      supported.push(sentence)
    } else {
      unsupported.push(sentence)
    }
  }

  const totalSentences = supported.length + unsupported.length
  const confidence = totalSentences > 0 ? supported.length / totalSentences : 1

  return {
    isGrounded: confidence >= DEFAULT_CONFIG.confidenceThreshold,
    confidence,
    supportedClaims: supported,
    unsupportedClaims: unsupported,
    method: "heuristic",
    explanation:
      unsupported.length === 0
        ? "All claims in the answer are supported by the context."
        : `${unsupported.length} of ${totalSentences} claims may not be fully supported by the retrieved context.`,
  }
}

// ---------------------------------------------------------------------------
// LLM Grounding Check
// ---------------------------------------------------------------------------

/**
 * Check answer grounding using an LLM judge.
 */
export async function checkGroundingLLM(
  answer: string,
  context: string,
  model: LanguageModel
): Promise<GroundingCheckResult> {
  try {
    const truncatedAnswer = answer.slice(0, DEFAULT_CONFIG.maxAnswerLength)
    const truncatedContext = context.slice(0, DEFAULT_CONFIG.maxContextLength)

    const prompt = `You are a grounding evaluator. Determine whether the given answer is fully supported by the provided context.

Context:
"""
${truncatedContext}
"""

Answer to evaluate:
"""
${truncatedAnswer}
"""

Instructions:
1. Identify the key factual claims in the answer.
2. For each claim, check if it is supported by the context.
3. List supported and unsupported claims.
4. Give an overall grounding score from 0 to 10.

Respond in this exact format:
SCORE: <0-10>
SUPPORTED: <comma-separated list of supported claims, or "none">
UNSUPPORTED: <comma-separated list of unsupported claims, or "none">
EXPLANATION: <one sentence summary>`

    const result = await generateText({
      model,
      prompt,
      temperature: 0,
    })

    const text = result.text.trim()
    const scoreMatch = text.match(/SCORE:\s*(\d+(?:\.\d+)?)/i)
    const supportedMatch = text.match(/SUPPORTED:\s*(.+)/i)
    const unsupportedMatch = text.match(/UNSUPPORTED:\s*(.+)/i)
    const explanationMatch = text.match(/EXPLANATION:\s*(.+)/i)

    const score = scoreMatch ? parseFloat(scoreMatch[1]) / 10 : 0.5
    const supportedRaw = supportedMatch?.[1]?.trim() || ""
    const unsupportedRaw = unsupportedMatch?.[1]?.trim() || ""
    const explanation = explanationMatch?.[1]?.trim() || ""

    const parseClaims = (raw: string): string[] => {
      if (!raw || raw.toLowerCase() === "none") return []
      return raw
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
    }

    const confidence = Math.max(0, Math.min(1, score))

    return {
      isGrounded: confidence >= DEFAULT_CONFIG.confidenceThreshold,
      confidence,
      supportedClaims: parseClaims(supportedRaw),
      unsupportedClaims: parseClaims(unsupportedRaw),
      method: "llm",
      explanation,
    }
  } catch (error) {
    log.warn("LLM grounding check failed, falling back to heuristic", { error: String(error) })
    return checkGroundingHeuristic(answer, context)
  }
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Check whether a generated answer is grounded in the retrieved context.
 * Use this after generation to detect potential hallucinations.
 */
export async function checkAnswerGrounding(
  answer: string,
  context: string,
  config: Partial<GroundingCheckConfig> = {}
): Promise<GroundingCheckResult> {
  const cfg: GroundingCheckConfig = { ...DEFAULT_CONFIG, ...config }

  if (!answer || !context) {
    return {
      isGrounded: !answer, // Empty answer is "grounded"; answer without context is not
      confidence: !answer ? 1 : 0,
      supportedClaims: [],
      unsupportedClaims: answer ? [answer] : [],
      method: "heuristic",
      explanation: !answer ? "No answer provided." : "No context available to verify the answer.",
    }
  }

  if (cfg.useLLM && cfg.model) {
    return checkGroundingLLM(
      answer.slice(0, cfg.maxAnswerLength),
      context.slice(0, cfg.maxContextLength),
      cfg.model
    )
  }

  return checkGroundingHeuristic(
    answer.slice(0, cfg.maxAnswerLength),
    context.slice(0, cfg.maxContextLength)
  )
}

/**
 * Quick boolean check: is the answer likely grounded?
 */
export function isAnswerGrounded(
  answer: string,
  context: string,
  threshold: number = 0.6
): boolean {
  const result = checkGroundingHeuristic(answer, context)
  return result.confidence >= threshold
}
