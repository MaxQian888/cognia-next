/**
 * Plugin Analytics System
 * Tracks plugin usage, performance, and provides learning insights
 */

// =============================================================================
// Types
// =============================================================================

export interface PluginUsageEvent {
  pluginId: string
  eventType: "tool_call" | "component_render" | "mode_switch" | "config_change" | "error"
  toolName?: string
  componentType?: string
  modeId?: string
  duration?: number
  success: boolean
  errorMessage?: string
  metadata?: Record<string, unknown>
  timestamp: number
}

export interface PluginUsageStats {
  pluginId: string
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  averageDuration: number
  lastUsed: number
  firstUsed: number
  toolUsage: Record<string, ToolUsageStats>
  componentUsage: Record<string, number>
  modeUsage: Record<string, number>
  errorHistory: ErrorRecord[]
  dailyUsage: DailyUsage[]
}

export interface ToolUsageStats {
  name: string
  callCount: number
  successCount: number
  averageDuration: number
  lastUsed: number
}

export interface ErrorRecord {
  timestamp: number
  errorType: string
  message: string
  context?: string
}

export interface DailyUsage {
  date: string
  calls: number
  duration: number
}

export interface PluginRecommendation {
  pluginId: string
  reason: string
  score: number
  basedOn: "usage_pattern" | "similar_users" | "task_context" | "capability_match"
}

export interface LearningInsight {
  type: "optimization" | "warning" | "suggestion" | "achievement"
  title: string
  description: string
  pluginId?: string
  actionable: boolean
  action?: {
    label: string
    type: "enable_plugin" | "disable_plugin" | "configure" | "view_docs"
    data?: Record<string, unknown>
  }
}

// =============================================================================
// Analytics Store (In-Memory + Persistent)
// =============================================================================

class PluginAnalyticsStore {
  private events: PluginUsageEvent[] = []
  private stats: Map<string, PluginUsageStats> = new Map()
  private maxEventsInMemory = 1000
  private persistKey = "plugin_analytics"
  private memoryPersistence = new Map<string, string>()

  private readPersistedValue(key: string): string | null {
    try {
      if (typeof localStorage !== "undefined") {
        return localStorage.getItem(key)
      }
    } catch {
      // ignore localStorage failure
    }
    return this.memoryPersistence.get(key) ?? null
  }

  private writePersistedValue(key: string, value: string): void {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(key, value)
        return
      }
    } catch {
      // ignore localStorage failure
    }
    this.memoryPersistence.set(key, value)
  }

  private removePersistedValue(key: string): void {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(key)
      }
    } catch {
      // ignore localStorage failure
    }
    this.memoryPersistence.delete(key)
  }

  async initialize(): Promise<void> {
    try {
      const stored = this.readPersistedValue(this.persistKey)
      if (stored) {
        const data = JSON.parse(stored)
        this.stats = new Map(Object.entries(data.stats || {}))
      }
    } catch {
      // Storage not available, use memory only
    }
  }

  async recordEvent(event: PluginUsageEvent): Promise<void> {
    this.events.push(event)

    // Trim events if too many
    if (this.events.length > this.maxEventsInMemory) {
      this.events = this.events.slice(-this.maxEventsInMemory)
    }

    // Update stats
    this.updateStats(event)

    // Persist periodically
    if (this.events.length % 10 === 0) {
      await this.persist()
    }
  }

  private updateStats(event: PluginUsageEvent): void {
    let stats = this.stats.get(event.pluginId)

    if (!stats) {
      stats = {
        pluginId: event.pluginId,
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        averageDuration: 0,
        lastUsed: event.timestamp,
        firstUsed: event.timestamp,
        toolUsage: {},
        componentUsage: {},
        modeUsage: {},
        errorHistory: [],
        dailyUsage: [],
      }
      this.stats.set(event.pluginId, stats)
    }

    stats.totalCalls++
    stats.lastUsed = event.timestamp

    if (event.success) {
      stats.successfulCalls++
    } else {
      stats.failedCalls++
      if (event.errorMessage) {
        stats.errorHistory.push({
          timestamp: event.timestamp,
          errorType: event.eventType,
          message: event.errorMessage,
          context: event.toolName || event.componentType,
        })
        // Keep only last 50 errors
        if (stats.errorHistory.length > 50) {
          stats.errorHistory = stats.errorHistory.slice(-50)
        }
      }
    }

    // Update duration average
    if (event.duration !== undefined) {
      const totalDuration = stats.averageDuration * (stats.totalCalls - 1) + event.duration
      stats.averageDuration = totalDuration / stats.totalCalls
    }

    // Update tool usage
    if (event.eventType === "tool_call" && event.toolName) {
      const toolStats = stats.toolUsage[event.toolName] || {
        name: event.toolName,
        callCount: 0,
        successCount: 0,
        averageDuration: 0,
        lastUsed: event.timestamp,
      }
      toolStats.callCount++
      toolStats.lastUsed = event.timestamp
      if (event.success) toolStats.successCount++
      if (event.duration !== undefined) {
        const totalDur = toolStats.averageDuration * (toolStats.callCount - 1) + event.duration
        toolStats.averageDuration = totalDur / toolStats.callCount
      }
      stats.toolUsage[event.toolName] = toolStats
    }

    // Update component usage
    if (event.eventType === "component_render" && event.componentType) {
      stats.componentUsage[event.componentType] =
        (stats.componentUsage[event.componentType] || 0) + 1
    }

    // Update mode usage
    if (event.eventType === "mode_switch" && event.modeId) {
      stats.modeUsage[event.modeId] = (stats.modeUsage[event.modeId] || 0) + 1
    }

    // Update daily usage
    const today = new Date(event.timestamp).toISOString().split("T")[0]
    let dailyEntry = stats.dailyUsage.find((d) => d.date === today)
    if (!dailyEntry) {
      dailyEntry = { date: today, calls: 0, duration: 0 }
      stats.dailyUsage.push(dailyEntry)
      // Keep only last 30 days
      if (stats.dailyUsage.length > 30) {
        stats.dailyUsage = stats.dailyUsage.slice(-30)
      }
    }
    dailyEntry.calls++
    dailyEntry.duration += event.duration || 0
  }

  getStats(pluginId: string): PluginUsageStats | undefined {
    return this.stats.get(pluginId)
  }

  getAllStats(): PluginUsageStats[] {
    return Array.from(this.stats.values())
  }

  getRecentEvents(pluginId?: string, limit = 100): PluginUsageEvent[] {
    let events = this.events
    if (pluginId) {
      events = events.filter((e) => e.pluginId === pluginId)
    }
    return events.slice(-limit)
  }

  private async persist(): Promise<void> {
    try {
      const data = {
        stats: Object.fromEntries(this.stats),
        lastUpdated: Date.now(),
      }
      this.writePersistedValue(this.persistKey, JSON.stringify(data))
    } catch {
      // Ignore persistence errors
    }
  }

  async clear(): Promise<void> {
    this.events = []
    this.stats.clear()
    try {
      this.removePersistedValue(this.persistKey)
    } catch {
      // Ignore
    }
  }
}

// =============================================================================
// Learning Engine
// =============================================================================

class PluginLearningEngine {
  private analyticsStore: PluginAnalyticsStore

  constructor(analyticsStore: PluginAnalyticsStore) {
    this.analyticsStore = analyticsStore
  }

  generateInsights(): LearningInsight[] {
    const insights: LearningInsight[] = []
    const allStats = this.analyticsStore.getAllStats()

    for (const stats of allStats) {
      // High error rate warning
      if (stats.totalCalls > 10 && stats.failedCalls / stats.totalCalls > 0.3) {
        insights.push({
          type: "warning",
          title: `High Error Rate: ${stats.pluginId}`,
          description: `This plugin has a ${Math.round((stats.failedCalls / stats.totalCalls) * 100)}% error rate. Consider reviewing its configuration or reporting issues.`,
          pluginId: stats.pluginId,
          actionable: true,
          action: {
            label: "Configure Plugin",
            type: "configure",
            data: { pluginId: stats.pluginId },
          },
        })
      }

      // Unused plugin suggestion
      const daysSinceLastUse = (Date.now() - stats.lastUsed) / (1000 * 60 * 60 * 24)
      if (daysSinceLastUse > 14 && stats.totalCalls > 5) {
        insights.push({
          type: "suggestion",
          title: `Unused Plugin: ${stats.pluginId}`,
          description: `You haven't used this plugin in ${Math.round(daysSinceLastUse)} days. Consider disabling it to improve performance.`,
          pluginId: stats.pluginId,
          actionable: true,
          action: {
            label: "Disable Plugin",
            type: "disable_plugin",
            data: { pluginId: stats.pluginId },
          },
        })
      }

      // Performance optimization
      if (stats.averageDuration > 5000 && stats.totalCalls > 20) {
        insights.push({
          type: "optimization",
          title: `Slow Plugin: ${stats.pluginId}`,
          description: `Average response time is ${(stats.averageDuration / 1000).toFixed(1)}s. This may impact user experience.`,
          pluginId: stats.pluginId,
          actionable: false,
        })
      }

      // Achievement for heavy usage
      if (stats.totalCalls > 100 && stats.successfulCalls / stats.totalCalls > 0.9) {
        insights.push({
          type: "achievement",
          title: `Power User: ${stats.pluginId}`,
          description: `You've successfully used this plugin ${stats.successfulCalls} times with a 90%+ success rate!`,
          pluginId: stats.pluginId,
          actionable: false,
        })
      }
    }

    // Sort by type priority
    const typePriority = { warning: 0, optimization: 1, suggestion: 2, achievement: 3 }
    insights.sort((a, b) => typePriority[a.type] - typePriority[b.type])

    return insights
  }

  generateRecommendations(
    enabledPlugins: string[],
    availablePlugins: Array<{ id: string; capabilities: string[]; description: string }>,
    recentContext?: string
  ): PluginRecommendation[] {
    const recommendations: PluginRecommendation[] = []
    const allStats = this.analyticsStore.getAllStats()

    // Find most used capabilities
    const capabilityUsage: Record<string, number> = {}
    for (const stats of allStats) {
      if (Object.keys(stats.toolUsage).length > 0) {
        capabilityUsage["tools"] = (capabilityUsage["tools"] || 0) + stats.totalCalls
      }
      if (Object.keys(stats.componentUsage).length > 0) {
        capabilityUsage["components"] = (capabilityUsage["components"] || 0) + stats.totalCalls
      }
      if (Object.keys(stats.modeUsage).length > 0) {
        capabilityUsage["modes"] = (capabilityUsage["modes"] || 0) + stats.totalCalls
      }
    }

    // Recommend plugins with matching capabilities
    for (const plugin of availablePlugins) {
      if (enabledPlugins.includes(plugin.id)) continue

      let score = 0
      let reason = ""

      // Check capability match
      for (const cap of plugin.capabilities) {
        if (capabilityUsage[cap]) {
          score += capabilityUsage[cap] * 0.1
          reason = `Matches your usage pattern for ${cap}`
        }
      }

      // Check context match
      if (recentContext && plugin.description) {
        const contextWords = recentContext.toLowerCase().split(/\s+/)
        const descWords = plugin.description.toLowerCase().split(/\s+/)
        const matches = contextWords.filter((w) => descWords.includes(w)).length
        if (matches > 2) {
          score += matches * 5
          reason = "Relevant to your current task"
        }
      }

      if (score > 0) {
        recommendations.push({
          pluginId: plugin.id,
          reason,
          score,
          basedOn: recentContext ? "task_context" : "capability_match",
        })
      }
    }

    // Sort by score
    recommendations.sort((a, b) => b.score - a.score)

    return recommendations.slice(0, 5)
  }

  getUsagePattern(pluginId: string): {
    peakHours: number[]
    commonTools: string[]
    averageSessionDuration: number
  } {
    const stats = this.analyticsStore.getStats(pluginId)
    if (!stats) {
      return { peakHours: [], commonTools: [], averageSessionDuration: 0 }
    }

    // Analyze events for peak hours
    const events = this.analyticsStore.getRecentEvents(pluginId)
    const hourCounts: Record<number, number> = {}
    for (const event of events) {
      const hour = new Date(event.timestamp).getHours()
      hourCounts[hour] = (hourCounts[hour] || 0) + 1
    }

    const peakHours = Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hour]) => parseInt(hour))

    // Get common tools
    const commonTools = Object.entries(stats.toolUsage)
      .sort((a, b) => b[1].callCount - a[1].callCount)
      .slice(0, 5)
      .map(([name]) => name)

    return {
      peakHours,
      commonTools,
      averageSessionDuration: stats.averageDuration,
    }
  }
}

// =============================================================================
// Plugin Health Monitor
// =============================================================================

export interface PluginHealthStatus {
  pluginId: string
  status: "healthy" | "degraded" | "unhealthy"
  score: number // 0-100
  issues: HealthIssue[]
  lastChecked: number
}

export interface HealthIssue {
  severity: "low" | "medium" | "high" | "critical"
  code: string
  message: string
  suggestion?: string
}

class PluginHealthMonitor {
  private analyticsStore: PluginAnalyticsStore

  constructor(analyticsStore: PluginAnalyticsStore) {
    this.analyticsStore = analyticsStore
  }

  checkHealth(pluginId: string): PluginHealthStatus {
    const stats = this.analyticsStore.getStats(pluginId)
    const issues: HealthIssue[] = []
    let score = 100

    if (!stats) {
      return {
        pluginId,
        status: "healthy",
        score: 100,
        issues: [],
        lastChecked: Date.now(),
      }
    }

    // Check error rate
    if (stats.totalCalls > 5) {
      const errorRate = stats.failedCalls / stats.totalCalls
      if (errorRate > 0.5) {
        issues.push({
          severity: "critical",
          code: "HIGH_ERROR_RATE",
          message: `Error rate is ${(errorRate * 100).toFixed(0)}%`,
          suggestion: "Check plugin configuration and dependencies",
        })
        score -= 40
      } else if (errorRate > 0.2) {
        issues.push({
          severity: "high",
          code: "ELEVATED_ERROR_RATE",
          message: `Error rate is ${(errorRate * 100).toFixed(0)}%`,
          suggestion: "Review recent errors for patterns",
        })
        score -= 20
      }
    }

    // Check response time
    if (stats.averageDuration > 10000) {
      issues.push({
        severity: "high",
        code: "SLOW_RESPONSE",
        message: `Average response time is ${(stats.averageDuration / 1000).toFixed(1)}s`,
        suggestion: "Consider optimizing plugin or checking network",
      })
      score -= 15
    } else if (stats.averageDuration > 5000) {
      issues.push({
        severity: "medium",
        code: "MODERATE_LATENCY",
        message: `Average response time is ${(stats.averageDuration / 1000).toFixed(1)}s`,
      })
      score -= 5
    }

    // Check recent errors
    const recentErrors = stats.errorHistory.filter(
      (e) => Date.now() - e.timestamp < 24 * 60 * 60 * 1000
    )
    if (recentErrors.length > 10) {
      issues.push({
        severity: "high",
        code: "RECENT_ERROR_SPIKE",
        message: `${recentErrors.length} errors in the last 24 hours`,
        suggestion: "Investigate recent changes or external factors",
      })
      score -= 15
    }

    // Determine status
    let status: "healthy" | "degraded" | "unhealthy" = "healthy"
    if (score < 50) {
      status = "unhealthy"
    } else if (score < 80) {
      status = "degraded"
    }

    return {
      pluginId,
      status,
      score: Math.max(0, score),
      issues,
      lastChecked: Date.now(),
    }
  }

  checkAllHealth(pluginIds: string[]): PluginHealthStatus[] {
    return pluginIds.map((id) => this.checkHealth(id))
  }
}

// =============================================================================
// Singleton Instances & Exports
// =============================================================================

export const pluginAnalyticsStore = new PluginAnalyticsStore()
export const pluginLearningEngine = new PluginLearningEngine(pluginAnalyticsStore)
export const pluginHealthMonitor = new PluginHealthMonitor(pluginAnalyticsStore)

// Convenience functions
export async function initializeAnalytics(): Promise<void> {
  await pluginAnalyticsStore.initialize()
}

export async function trackPluginEvent(event: Omit<PluginUsageEvent, "timestamp">): Promise<void> {
  await pluginAnalyticsStore.recordEvent({
    ...event,
    timestamp: Date.now(),
  })
}

export function getPluginInsights(): LearningInsight[] {
  return pluginLearningEngine.generateInsights()
}

export function getPluginHealth(pluginId: string): PluginHealthStatus {
  return pluginHealthMonitor.checkHealth(pluginId)
}

export function getPluginRecommendations(
  enabledPlugins: string[],
  availablePlugins: Array<{ id: string; capabilities: string[]; description: string }>,
  context?: string
): PluginRecommendation[] {
  return pluginLearningEngine.generateRecommendations(enabledPlugins, availablePlugins, context)
}
