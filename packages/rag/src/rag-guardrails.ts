/**
 * RAG Guardrails — Input/Output Safety
 *
 * Validates and sanitizes inputs to the RAG pipeline,
 * assesses confidence of retrieval results, and detects
 * low-quality or potentially harmful outputs.
 *
 * Features:
 * - Query sanitization (length, injection patterns)
 * - Input validation
 * - Retrieval confidence assessment
 * - Low-confidence detection
 */

import type { RerankResult } from "./reranker"
import { getRAGLogger } from "./runtime-adapters"

const log = getRAGLogger()

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface GuardrailsConfig {
  /** Maximum query length in characters */
  maxQueryLength: number
  /** Maximum collection name length */
  maxCollectionNameLength: number
  /** Minimum query length */
  minQueryLength: number
  /** Low confidence threshold */
  lowConfidenceThreshold: number
  /** Enable injection pattern detection */
  detectInjection: boolean
}

const DEFAULT_CONFIG: GuardrailsConfig = {
  maxQueryLength: 10000,
  maxCollectionNameLength: 256,
  minQueryLength: 1,
  lowConfidenceThreshold: 0.3,
  detectInjection: true,
}

// ---------------------------------------------------------------------------
// Injection Patterns
// ---------------------------------------------------------------------------

/** Common prompt injection patterns to detect and strip */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/gi,
  /forget\s+(all\s+)?previous/gi,
  /you\s+are\s+now\s+(a|an)\s+/gi,
  /system\s*:\s*/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /<<SYS>>/gi,
  /<\/SYS>>/gi,
]

export interface RetrievedContentTrustAssessment {
  trust: "untrusted" | "quarantined"
  risk: "none" | "high"
  reasonCodes: string[]
}

/** Detect high-risk instructions without modifying or silently sanitizing evidence. */
export function assessRetrievedContentTrust(content: string): RetrievedContentTrustAssessment {
  const reasonCodes: string[] = []
  for (const pattern of INJECTION_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(content)) reasonCodes.push("instruction_override")
    pattern.lastIndex = 0
  }
  if (/<\/?(?:system|assistant|tool|developer)(?:\s|>)/i.test(content)) {
    reasonCodes.push("role_boundary_markup")
  }
  const unique = [...new Set(reasonCodes)]
  return {
    trust: unique.length > 0 ? "quarantined" : "untrusted",
    risk: unique.length > 0 ? "high" : "none",
    reasonCodes: unique,
  }
}

// ---------------------------------------------------------------------------
// Query Sanitization
// ---------------------------------------------------------------------------

export interface SanitizationResult {
  /** Sanitized query text */
  query: string
  /** Whether the query was modified */
  modified: boolean
  /** List of modifications applied */
  modifications: string[]
  /** Whether injection patterns were detected */
  injectionDetected: boolean
}

/**
 * Sanitize a query before passing it to the RAG pipeline.
 * Strips injection patterns, enforces length limits, normalizes whitespace.
 */
export function sanitizeQuery(
  query: string,
  config: Partial<GuardrailsConfig> = {}
): SanitizationResult {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const modifications: string[] = []
  let sanitized = query
  let injectionDetected = false

  // 1. Trim and normalize whitespace
  sanitized = sanitized.trim().replace(/\s+/g, " ")
  if (sanitized !== query.trim()) {
    modifications.push("normalized_whitespace")
  }

  // 2. Enforce max length
  if (sanitized.length > cfg.maxQueryLength) {
    sanitized = sanitized.slice(0, cfg.maxQueryLength)
    modifications.push(`truncated_to_${cfg.maxQueryLength}_chars`)
  }

  // 3. Detect and strip injection patterns
  if (cfg.detectInjection) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(sanitized)) {
        injectionDetected = true
        sanitized = sanitized.replace(pattern, "")
        modifications.push(`stripped_injection_pattern`)
      }
      // Reset regex lastIndex for global patterns
      pattern.lastIndex = 0
    }
  }

  // 4. Strip control characters (except newlines and tabs)
  const beforeControl = sanitized
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
  if (sanitized !== beforeControl) {
    modifications.push("stripped_control_chars")
  }

  // 5. Final trim
  sanitized = sanitized.trim()

  if (injectionDetected) {
    log.warn("Potential prompt injection detected in RAG query", {
      originalLength: query.length,
      sanitizedLength: sanitized.length,
    })
  }

  return {
    query: sanitized,
    modified: modifications.length > 0,
    modifications,
    injectionDetected,
  }
}

// ---------------------------------------------------------------------------
// Input Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Validate retrieval input parameters.
 */
export function validateRetrievalInput(
  query: string,
  collectionName: string,
  config: Partial<GuardrailsConfig> = {}
): ValidationResult {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const errors: string[] = []

  // Query validation
  if (!query || typeof query !== "string") {
    errors.push("Query must be a non-empty string")
  } else {
    if (query.trim().length < cfg.minQueryLength) {
      errors.push(`Query must be at least ${cfg.minQueryLength} character(s)`)
    }
    if (query.length > cfg.maxQueryLength) {
      errors.push(`Query exceeds maximum length of ${cfg.maxQueryLength} characters`)
    }
  }

  // Collection name validation
  if (!collectionName || typeof collectionName !== "string") {
    errors.push("Collection name must be a non-empty string")
  } else {
    if (collectionName.length > cfg.maxCollectionNameLength) {
      errors.push(
        `Collection name exceeds maximum length of ${cfg.maxCollectionNameLength} characters`
      )
    }
    if (!/^[\w\-. ]+$/.test(collectionName)) {
      errors.push(
        "Collection name contains invalid characters (only alphanumeric, dash, dot, underscore, space allowed)"
      )
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

// ---------------------------------------------------------------------------
// Confidence Assessment
// ---------------------------------------------------------------------------

export interface ConfidenceAssessment {
  /** Overall confidence score (0-1) */
  confidence: number
  /** Whether confidence is below the low threshold */
  isLowConfidence: boolean
  /** Breakdown of confidence factors */
  factors: {
    /** Score based on number of results */
    resultCount: number
    /** Average relevance score of results */
    averageScore: number
    /** Score diversity (higher = more diverse sources) */
    diversity: number
    /** Top result quality */
    topResultQuality: number
  }
  /** Human-readable assessment */
  assessment: string
}

/**
 * Assess the confidence of retrieval results.
 * Use this to decide whether to show a disclaimer or fallback.
 */
export function assessConfidence(
  documents: RerankResult[],
  config: Partial<GuardrailsConfig> = {}
): ConfidenceAssessment {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  if (documents.length === 0) {
    return {
      confidence: 0,
      isLowConfidence: true,
      factors: { resultCount: 0, averageScore: 0, diversity: 0, topResultQuality: 0 },
      assessment: "No relevant documents found.",
    }
  }

  // Factor 1: Result count (0-1, saturates at 5 results)
  const resultCount = Math.min(documents.length / 5, 1)

  // Factor 2: Average relevance score
  const averageScore = documents.reduce((sum, d) => sum + d.rerankScore, 0) / documents.length

  // Factor 3: Diversity — count unique source documents
  const sources = new Set(
    documents.map((d) => d.metadata?.documentId || d.metadata?.source || d.id).filter(Boolean)
  )
  const diversity = Math.min(sources.size / Math.max(documents.length, 1), 1)

  // Factor 4: Top result quality
  const topResultQuality = documents[0]?.rerankScore ?? 0

  // Weighted confidence
  const confidence =
    resultCount * 0.2 + averageScore * 0.3 + diversity * 0.2 + topResultQuality * 0.3

  const isLowConfidence = confidence < cfg.lowConfidenceThreshold

  // Generate assessment
  let assessment: string
  if (confidence >= 0.8) {
    assessment = "High confidence: multiple relevant sources found."
  } else if (confidence >= 0.5) {
    assessment = "Moderate confidence: some relevant content found but coverage may be incomplete."
  } else if (confidence >= 0.3) {
    assessment = "Low confidence: limited relevant content found. Answer may be incomplete."
  } else {
    assessment = "Very low confidence: retrieved content may not adequately address the query."
  }

  return {
    confidence: Math.max(0, Math.min(1, confidence)),
    isLowConfidence,
    factors: {
      resultCount,
      averageScore,
      diversity,
      topResultQuality,
    },
    assessment,
  }
}

/**
 * Quick check: is the retrieval confidence below threshold?
 */
export function detectLowConfidence(documents: RerankResult[], threshold: number = 0.3): boolean {
  return assessConfidence(documents, { lowConfidenceThreshold: threshold }).isLowConfidence
}
