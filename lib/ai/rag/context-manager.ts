/**
 * Dynamic Context Manager
 *
 * Manages context window sizing and chunk selection
 * for optimal LLM performance.
 *
 * Features:
 * - Dynamic context length calculation
 * - Intelligent chunk selection
 * - Token budget management
 * - Context compression
 * - Priority-based selection
 */

import type { RerankResult } from "./reranker"
import type { SearchResult } from "@/lib/vector/chroma-client"

export interface ContextManagerConfig {
  maxTokens: number
  minChunks: number
  maxChunks: number
  reserveTokens: number // Reserve for system prompt and response
  charsPerToken: number
  priorityWeights: {
    relevance: number
    recency: number
    diversity: number
  }
}

export interface ContextBudget {
  totalTokens: number
  usedTokens: number
  remainingTokens: number
  selectedChunks: number
  truncatedChunks: number
}

export interface ChunkWithScore {
  id: string
  content: string
  metadata?: Record<string, unknown>
  score: number
  tokens: number
}

export interface ContextSelectionResult {
  chunks: ChunkWithScore[]
  budget: ContextBudget
  formattedContext: string
  compressionApplied: boolean
}

const DEFAULT_CONFIG: ContextManagerConfig = {
  maxTokens: 8000,
  minChunks: 1,
  maxChunks: 10,
  reserveTokens: 2000,
  charsPerToken: 4,
  priorityWeights: {
    relevance: 0.6,
    recency: 0.2,
    diversity: 0.2,
  },
}

/**
 * Dynamic Context Manager
 */
export class DynamicContextManager {
  private config: ContextManagerConfig

  constructor(config: Partial<ContextManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Estimate token count for text
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / this.config.charsPerToken)
  }

  /**
   * Calculate optimal context length based on query complexity
   */
  calculateOptimalContextLength(
    query: string,
    results: (RerankResult | SearchResult)[],
    maxTokens?: number
  ): number {
    const effectiveMax = maxTokens ?? this.config.maxTokens
    const availableTokens = effectiveMax - this.config.reserveTokens

    // Analyze query complexity
    const _queryTokens = this.estimateTokens(query)
    const queryComplexity = this.analyzeQueryComplexity(query)

    // Calculate total available content
    const totalContentTokens = results.reduce((sum, r) => {
      return sum + this.estimateTokens(r.content)
    }, 0)

    // Adjust context length based on complexity
    let targetLength = availableTokens

    if (queryComplexity === "simple") {
      // Simple queries need less context
      targetLength = Math.min(availableTokens, totalContentTokens, 2000)
    } else if (queryComplexity === "moderate") {
      // Moderate queries need balanced context
      targetLength = Math.min(availableTokens, totalContentTokens * 0.8, 4000)
    } else {
      // Complex queries may need full context
      targetLength = Math.min(availableTokens, totalContentTokens)
    }

    return Math.max(targetLength, 500) // Minimum 500 tokens
  }

  /**
   * Analyze query complexity
   */
  private analyzeQueryComplexity(query: string): "simple" | "moderate" | "complex" {
    const words = query.split(/\s+/).length
    const hasMultipleClauses = /\b(and|or|but|however|also|furthermore)\b/i.test(query)
    const hasQuestions = (query.match(/\?/g) || []).length
    const hasComparison = /\b(compare|difference|versus|vs|between|against)\b/i.test(query)
    const hasAnalysis = /\b(analyze|explain|describe|why|how|what)\b/i.test(query)

    let complexity = 0

    if (words > 20) complexity += 2
    else if (words > 10) complexity += 1

    if (hasMultipleClauses) complexity += 1
    if (hasQuestions > 1) complexity += 1
    if (hasComparison) complexity += 2
    if (hasAnalysis) complexity += 1

    if (complexity >= 4) return "complex"
    if (complexity >= 2) return "moderate"
    return "simple"
  }

  /**
   * Select optimal chunks within token budget
   */
  selectOptimalChunks(
    results: (RerankResult | SearchResult)[],
    targetLength: number
  ): ContextSelectionResult {
    const chunks: ChunkWithScore[] = results.map((r) => ({
      id: r.id,
      content: r.content,
      metadata: r.metadata,
      score: "rerankScore" in r ? r.rerankScore : (r as SearchResult).similarity || 0,
      tokens: this.estimateTokens(r.content),
    }))

    // Sort by score
    chunks.sort((a, b) => b.score - a.score)

    const selected: ChunkWithScore[] = []
    let usedTokens = 0
    let truncatedCount = 0

    for (const chunk of chunks) {
      if (selected.length >= this.config.maxChunks) break

      if (usedTokens + chunk.tokens <= targetLength) {
        // Chunk fits completely
        selected.push(chunk)
        usedTokens += chunk.tokens
      } else if (selected.length < this.config.minChunks) {
        // Must include minimum chunks, truncate if needed
        const remainingTokens = targetLength - usedTokens
        if (remainingTokens >= 100) {
          const truncatedContent = this.truncateToTokens(chunk.content, remainingTokens)
          selected.push({
            ...chunk,
            content: truncatedContent,
            tokens: remainingTokens,
          })
          usedTokens += remainingTokens
          truncatedCount++
        }
      }
    }

    // Apply diversity optimization if we have room
    const diversified = this.applyDiversityOptimization(selected)

    // Format context
    const formattedContext = this.formatContext(diversified)

    return {
      chunks: diversified,
      budget: {
        totalTokens: targetLength,
        usedTokens,
        remainingTokens: targetLength - usedTokens,
        selectedChunks: diversified.length,
        truncatedChunks: truncatedCount,
      },
      formattedContext,
      compressionApplied: truncatedCount > 0,
    }
  }

  /**
   * Truncate content to fit token budget
   */
  private truncateToTokens(content: string, maxTokens: number): string {
    const targetChars = maxTokens * this.config.charsPerToken

    if (content.length <= targetChars) {
      return content
    }

    // Try to truncate at sentence boundary, reserving space for '...'
    const ellipsis = "..."
    const charBudget = targetChars - ellipsis.length
    const truncated = content.slice(0, charBudget)
    const lastSentence = truncated.lastIndexOf(". ")

    if (lastSentence > charBudget * 0.7) {
      return truncated.slice(0, lastSentence + 1) + ellipsis
    }

    return truncated + ellipsis
  }

  /**
   * Apply diversity optimization to reduce redundancy
   */
  private applyDiversityOptimization(chunks: ChunkWithScore[]): ChunkWithScore[] {
    if (chunks.length <= 2) return chunks

    const result: ChunkWithScore[] = [chunks[0]]
    const seenContent = new Set<string>()

    // Add first chunk's content fingerprint
    seenContent.add(this.getContentFingerprint(chunks[0].content))

    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i]
      const fingerprint = this.getContentFingerprint(chunk.content)

      // Check similarity with already selected chunks
      let isDuplicate = seenContent.has(fingerprint)

      if (!isDuplicate) {
        // Also check for high content overlap
        for (const selected of result) {
          if (this.calculateContentSimilarity(chunk.content, selected.content) > 0.8) {
            isDuplicate = true
            break
          }
        }
      }

      if (!isDuplicate) {
        result.push(chunk)
        seenContent.add(fingerprint)
      }
    }

    return result
  }

  /**
   * Get content fingerprint for deduplication
   */
  private getContentFingerprint(content: string): string {
    // Simple fingerprint: first 50 chars + length
    const normalized = content.toLowerCase().replace(/\s+/g, " ").trim()
    return `${normalized.slice(0, 50)}:${normalized.length}`
  }

  /**
   * Calculate content similarity using Jaccard index
   */
  private calculateContentSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/))
    const wordsB = new Set(b.toLowerCase().split(/\s+/))

    let intersection = 0
    for (const word of wordsA) {
      if (wordsB.has(word)) intersection++
    }

    const union = wordsA.size + wordsB.size - intersection
    return union > 0 ? intersection / union : 0
  }

  /**
   * Format chunks into context string
   */
  private formatContext(chunks: ChunkWithScore[]): string {
    if (chunks.length === 0) return ""

    const parts: string[] = []

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const header = `[Source ${i + 1}]`
      const source = chunk.metadata?.source ? ` (${chunk.metadata.source})` : ""
      const title = chunk.metadata?.documentTitle ? `\nTitle: ${chunk.metadata.documentTitle}` : ""
      const relevance = ` [Relevance: ${(chunk.score * 100).toFixed(0)}%]`

      parts.push(`${header}${source}${relevance}${title}\n${chunk.content}`)
    }

    return parts.join("\n\n")
  }

  /**
   * Compress context if it exceeds token limit
   */
  compressContext(
    context: string,
    maxTokens: number
  ): { compressed: string; compressionRatio: number } {
    const originalTokens = this.estimateTokens(context)

    if (originalTokens <= maxTokens) {
      return { compressed: context, compressionRatio: 1 }
    }

    // Apply multiple compression strategies
    let compressed = context

    // 1. Remove redundant whitespace
    compressed = compressed.replace(/\s+/g, " ").trim()

    // 2. Shorten long sentences
    compressed = this.shortenSentences(compressed, 100)

    // 3. Remove less important phrases
    compressed = this.removeFillerPhrases(compressed)

    // 4. If still too long, truncate
    const compressedTokens = this.estimateTokens(compressed)
    if (compressedTokens > maxTokens) {
      compressed = this.truncateToTokens(compressed, maxTokens)
    }

    const finalTokens = this.estimateTokens(compressed)
    return {
      compressed,
      compressionRatio: finalTokens / originalTokens,
    }
  }

  /**
   * Shorten sentences longer than max words
   */
  private shortenSentences(text: string, maxWords: number): string {
    const sentences = text.split(/(?<=[.!?])\s+/)

    return sentences
      .map((sentence) => {
        const words = sentence.split(/\s+/)
        if (words.length > maxWords) {
          return words.slice(0, maxWords).join(" ") + "..."
        }
        return sentence
      })
      .join(" ")
  }

  /**
   * Remove filler phrases
   */
  private removeFillerPhrases(text: string): string {
    const fillers = [
      /\b(basically|essentially|actually|literally|really)\s+/gi,
      /\b(in order to)\b/gi,
      /\b(it is important to note that)\b/gi,
      /\b(it should be noted that)\b/gi,
      /\b(as mentioned (earlier|before|above))\s*/gi,
    ]

    let result = text
    for (const filler of fillers) {
      result = result.replace(filler, "")
    }

    return result.replace(/\s+/g, " ").trim()
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ContextManagerConfig>): void {
    Object.assign(this.config, config)
  }

  /**
   * Get current configuration
   */
  getConfig(): ContextManagerConfig {
    return { ...this.config }
  }
}

/**
 * Create a dynamic context manager
 */
export function createContextManager(
  config: Partial<ContextManagerConfig> = {}
): DynamicContextManager {
  return new DynamicContextManager(config)
}

// Re-export from canonical location for backward compatibility
export { getModelContextLimits, type ModelContextLimits } from "@/lib/ai/model-limits"
