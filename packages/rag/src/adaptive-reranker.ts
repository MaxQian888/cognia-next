/**
 * Adaptive Reranker
 *
 * Learning-based reranking with user feedback integration.
 * Improves relevance over time based on user interactions.
 *
 * Features:
 * - User feedback collection and storage
 * - Learning-based score adjustment
 * - A/B testing support
 * - Personalization based on history
 * - Feedback-driven model updates
 */

import type { RerankResult } from "./reranker"
import { getRAGLogger } from "./runtime-adapters"

const log = getRAGLogger()

export interface RelevanceFeedback {
  queryId: string
  resultId: string
  relevance: number // 0-1 scale, 1 being most relevant
  timestamp: number
  action: "click" | "use" | "dismiss" | "explicit"
  metadata?: Record<string, unknown>
}

export interface FeedbackHistoryEntry {
  query: string
  queryHash: string
  feedback: RelevanceFeedback[]
  lastUpdated: number
}

export interface AdaptiveRerankerConfig {
  enabled: boolean
  feedbackWeight: number // How much to weight feedback (0-1)
  decayFactor: number // Feedback decay over time
  minFeedbackCount: number // Min feedback before applying
  maxHistorySize: number
  persistFeedback: boolean
  storageKey: string
}

export interface LearningStats {
  totalFeedback: number
  uniqueQueries: number
  averageRelevance: number
  improvementRate: number
  lastTrainingTime: number
}

const DEFAULT_CONFIG: AdaptiveRerankerConfig = {
  enabled: true,
  feedbackWeight: 0.3,
  decayFactor: 0.95, // 5% decay per day
  minFeedbackCount: 3,
  maxHistorySize: 1000,
  persistFeedback: true,
  storageKey: "cognia-rag-feedback",
}

/**
 * Hash a query string for lookup
 */
function hashQuery(query: string): string {
  const normalized = query.toLowerCase().trim()
  let hash = 0
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }
  return hash.toString(36)
}

/**
 * Calculate time-based decay factor
 */
function calculateDecay(timestamp: number, decayFactor: number): number {
  const daysSince = (Date.now() - timestamp) / (1000 * 60 * 60 * 24)
  return Math.pow(decayFactor, daysSince)
}

/**
 * Adaptive Reranker with feedback learning
 */
export class AdaptiveReranker {
  private config: AdaptiveRerankerConfig
  private feedbackHistory: Map<string, FeedbackHistoryEntry> = new Map()
  private resultBoosts: Map<string, number> = new Map()
  private stats: LearningStats = {
    totalFeedback: 0,
    uniqueQueries: 0,
    averageRelevance: 0,
    improvementRate: 0,
    lastTrainingTime: 0,
  }
  private initialized = false

  constructor(config: Partial<AdaptiveRerankerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Initialize the reranker (load persisted feedback)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    if (this.config.persistFeedback && typeof localStorage !== "undefined") {
      try {
        const stored = localStorage.getItem(this.config.storageKey)
        if (stored) {
          const data = JSON.parse(stored)
          this.feedbackHistory = new Map(Object.entries(data.history || {}))
          this.stats = data.stats || this.stats
          this.rebuildBoosts()
        }
      } catch (error) {
        log.warn("Failed to load feedback history", { error: String(error) })
      }
    }

    this.initialized = true
  }

  /**
   * Rerank results with learning-based adjustments
   */
  async rerankWithLearning(
    query: string,
    results: RerankResult[],
    _feedback?: RelevanceFeedback[]
  ): Promise<RerankResult[]> {
    if (!this.config.enabled || results.length === 0) {
      return results
    }

    const queryHash = hashQuery(query)
    const history = this.feedbackHistory.get(queryHash)

    // If no feedback history, return original order
    if (!history || history.feedback.length < this.config.minFeedbackCount) {
      return results
    }

    // Apply learned boosts
    const boostedResults = results.map((result) => {
      const boost = this.calculateResultBoost(result.id, history)
      return {
        ...result,
        rerankScore: result.rerankScore * (1 + boost * this.config.feedbackWeight),
      }
    })

    // Re-sort by adjusted score
    return boostedResults.sort((a, b) => b.rerankScore - a.rerankScore)
  }

  /**
   * Calculate boost for a specific result based on feedback
   */
  private calculateResultBoost(resultId: string, history: FeedbackHistoryEntry): number {
    const relevantFeedback = history.feedback.filter((f) => f.resultId === resultId)

    if (relevantFeedback.length === 0) {
      // Check for similar results (same document, different chunks)
      const docId = resultId.split(":")[0]
      const similarFeedback = history.feedback.filter((f) => f.resultId.startsWith(docId))
      if (similarFeedback.length > 0) {
        return this.aggregateFeedback(similarFeedback) * 0.5 // Half weight for similar
      }
      return 0
    }

    return this.aggregateFeedback(relevantFeedback)
  }

  /**
   * Aggregate feedback scores with time decay
   */
  private aggregateFeedback(feedback: RelevanceFeedback[]): number {
    if (feedback.length === 0) return 0

    let totalWeight = 0
    let weightedSum = 0

    for (const f of feedback) {
      const decay = calculateDecay(f.timestamp, this.config.decayFactor)
      const actionWeight = this.getActionWeight(f.action)
      const weight = decay * actionWeight

      weightedSum += (f.relevance - 0.5) * 2 * weight // Normalize to -1 to 1
      totalWeight += weight
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0
  }

  /**
   * Get weight for different feedback actions
   */
  private getActionWeight(action: RelevanceFeedback["action"]): number {
    switch (action) {
      case "explicit":
        return 1.0
      case "use":
        return 0.8
      case "click":
        return 0.4
      case "dismiss":
        return 0.6
      default:
        return 0.5
    }
  }

  /**
   * Record user feedback for a result
   */
  recordFeedback(
    query: string,
    resultId: string,
    relevance: number,
    action: RelevanceFeedback["action"] = "explicit"
  ): void {
    const queryHash = hashQuery(query)
    const feedback: RelevanceFeedback = {
      queryId: queryHash,
      resultId,
      relevance: Math.max(0, Math.min(1, relevance)),
      timestamp: Date.now(),
      action,
    }

    // Get or create history entry
    let entry = this.feedbackHistory.get(queryHash)
    if (!entry) {
      entry = {
        query,
        queryHash,
        feedback: [],
        lastUpdated: Date.now(),
      }
      this.feedbackHistory.set(queryHash, entry)
      this.stats.uniqueQueries++
    }

    // Add feedback
    entry.feedback.push(feedback)
    entry.lastUpdated = Date.now()

    // Limit feedback per query
    if (entry.feedback.length > 100) {
      entry.feedback = entry.feedback.slice(-100)
    }

    // Update stats
    this.stats.totalFeedback++
    this.updateAverageRelevance(relevance)

    // Rebuild boost for this result
    this.updateResultBoost(resultId, entry)

    // Persist if enabled
    this.persistFeedback()

    // Prune old entries if needed
    if (this.feedbackHistory.size > this.config.maxHistorySize) {
      this.pruneOldEntries()
    }
  }

  /**
   * Record implicit feedback (click, use, dismiss)
   */
  recordImplicitFeedback(
    query: string,
    resultId: string,
    action: "click" | "use" | "dismiss"
  ): void {
    const relevance = action === "use" ? 0.9 : action === "click" ? 0.6 : 0.2
    this.recordFeedback(query, resultId, relevance, action)
  }

  /**
   * Update running average relevance
   */
  private updateAverageRelevance(relevance: number): void {
    const alpha = 0.1 // Exponential moving average factor
    this.stats.averageRelevance = this.stats.averageRelevance * (1 - alpha) + relevance * alpha
  }

  /**
   * Update boost for a specific result
   */
  private updateResultBoost(resultId: string, history: FeedbackHistoryEntry): void {
    const boost = this.calculateResultBoost(resultId, history)
    this.resultBoosts.set(resultId, boost)
  }

  /**
   * Rebuild all boosts from history
   */
  private rebuildBoosts(): void {
    this.resultBoosts.clear()

    for (const entry of this.feedbackHistory.values()) {
      for (const feedback of entry.feedback) {
        this.updateResultBoost(feedback.resultId, entry)
      }
    }
  }

  /**
   * Prune old entries to stay within size limit
   */
  private pruneOldEntries(): void {
    const entries = Array.from(this.feedbackHistory.entries())

    // Sort by last updated, oldest first
    entries.sort((a, b) => a[1].lastUpdated - b[1].lastUpdated)

    // Remove oldest entries until within limit
    const toRemove = entries.length - this.config.maxHistorySize
    for (let i = 0; i < toRemove; i++) {
      this.feedbackHistory.delete(entries[i][0])
    }
  }

  /**
   * Persist feedback to localStorage
   */
  private persistFeedback(): void {
    if (!this.config.persistFeedback || typeof localStorage === "undefined") {
      return
    }

    try {
      const data = {
        history: Object.fromEntries(this.feedbackHistory),
        stats: this.stats,
      }
      localStorage.setItem(this.config.storageKey, JSON.stringify(data))
    } catch (error) {
      log.warn("Failed to persist feedback", { error: String(error) })
    }
  }

  /**
   * Get learning statistics
   */
  getStats(): LearningStats {
    return { ...this.stats }
  }

  /**
   * Get feedback for a specific query
   */
  getQueryFeedback(query: string): RelevanceFeedback[] {
    const queryHash = hashQuery(query)
    const entry = this.feedbackHistory.get(queryHash)
    return entry?.feedback || []
  }

  /**
   * Clear all feedback history
   */
  clearHistory(): void {
    this.feedbackHistory.clear()
    this.resultBoosts.clear()
    this.stats = {
      totalFeedback: 0,
      uniqueQueries: 0,
      averageRelevance: 0,
      improvementRate: 0,
      lastTrainingTime: 0,
    }

    if (this.config.persistFeedback && typeof localStorage !== "undefined") {
      localStorage.removeItem(this.config.storageKey)
    }
  }

  /**
   * Export feedback data for analysis
   */
  exportFeedback(): {
    history: FeedbackHistoryEntry[]
    stats: LearningStats
  } {
    return {
      history: Array.from(this.feedbackHistory.values()),
      stats: this.getStats(),
    }
  }

  /**
   * Import feedback data
   */
  importFeedback(data: { history: FeedbackHistoryEntry[]; stats?: LearningStats }): void {
    for (const entry of data.history) {
      this.feedbackHistory.set(entry.queryHash, entry)
    }

    if (data.stats) {
      this.stats = data.stats
    }

    this.rebuildBoosts()
    this.persistFeedback()
  }

  /**
   * Enable or disable adaptive reranking
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
  }

  /**
   * Update feedback weight
   */
  setFeedbackWeight(weight: number): void {
    this.config.feedbackWeight = Math.max(0, Math.min(1, weight))
  }
}

/**
 * Create an adaptive reranker instance
 */
export function createAdaptiveReranker(
  config: Partial<AdaptiveRerankerConfig> = {}
): AdaptiveReranker {
  return new AdaptiveReranker(config)
}

/**
 * Singleton instance for global use
 */
let globalReranker: AdaptiveReranker | null = null

export function getGlobalAdaptiveReranker(): AdaptiveReranker {
  if (!globalReranker) {
    globalReranker = new AdaptiveReranker()
  }
  return globalReranker
}

export function resetGlobalAdaptiveReranker(): void {
  if (globalReranker) {
    globalReranker.clearHistory()
    globalReranker = null
  }
}
