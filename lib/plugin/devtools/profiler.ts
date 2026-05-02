/**
 * Plugin Profiler
 *
 * Performance profiling and resource monitoring for plugins.
 */

// =============================================================================
// Types
// =============================================================================

export interface ProfileEntry {
  id: string
  pluginId: string
  operation: string
  startTime: number
  endTime?: number
  duration?: number
  memoryBefore?: number
  memoryAfter?: number
  memoryDelta?: number
  metadata?: Record<string, unknown>
  children: ProfileEntry[]
  status: "running" | "completed" | "error"
  error?: string
}

export interface ProfileSummary {
  pluginId: string
  totalOperations: number
  totalDuration: number
  averageDuration: number
  peakMemory: number
  operationBreakdown: Record<string, OperationStats>
  hotspots: Hotspot[]
}

export interface OperationStats {
  count: number
  totalDuration: number
  averageDuration: number
  minDuration: number
  maxDuration: number
  errorCount: number
}

export interface Hotspot {
  operation: string
  percentage: number
  totalDuration: number
  count: number
}

export interface ProfilerConfig {
  enabled: boolean
  sampleRate: number
  maxEntries: number
  trackMemory: boolean
  captureStackTraces: boolean
}

export interface ResourceUsage {
  memory: number
  cpu?: number
  timestamp: number
}

// =============================================================================
// Plugin Profiler
// =============================================================================

export class PluginProfiler {
  private config: ProfilerConfig
  private entries: Map<string, ProfileEntry[]> = new Map()
  private activeProfiles: Map<string, ProfileEntry> = new Map()
  private activeSessions: Map<string, { startedAt: number }> = new Map()
  private resourceSnapshots: Map<string, ResourceUsage[]> = new Map()
  private profileStack: ProfileEntry[] = []

  constructor(config: Partial<ProfilerConfig> = {}) {
    this.config = {
      enabled: true,
      sampleRate: 1.0,
      maxEntries: 1000,
      trackMemory: true,
      captureStackTraces: false,
      ...config,
    }
  }

  // ===========================================================================
  // Profiling Operations
  // ===========================================================================

  startSession(pluginId: string): { pluginId: string; startedAt: number } {
    const session = {
      pluginId,
      startedAt: Date.now(),
    }
    this.activeSessions.set(pluginId, session)
    this.setEnabled(true)
    this.captureResourceSnapshot(pluginId)
    return session
  }

  endSession(pluginId: string): ProfileSummary {
    this.activeSessions.delete(pluginId)
    this.captureResourceSnapshot(pluginId)
    if (this.activeSessions.size === 0) {
      this.setEnabled(false)
    }
    return this.getSummary(pluginId)
  }

  isSessionActive(pluginId: string): boolean {
    return this.activeSessions.has(pluginId)
  }

  startProfile(pluginId: string, operation: string, metadata?: Record<string, unknown>): string {
    if (!this.shouldSample()) return ""

    const entry: ProfileEntry = {
      id: this.generateId(),
      pluginId,
      operation,
      startTime: performance.now(),
      memoryBefore: this.config.trackMemory ? this.getMemoryUsage() : undefined,
      metadata,
      children: [],
      status: "running",
    }

    // Link to parent if exists
    if (this.profileStack.length > 0) {
      const parent = this.profileStack[this.profileStack.length - 1]
      parent.children.push(entry)
    }

    this.profileStack.push(entry)
    this.activeProfiles.set(entry.id, entry)

    return entry.id
  }

  endProfile(profileId: string, error?: Error): ProfileEntry | undefined {
    if (!profileId) return undefined

    const entry = this.activeProfiles.get(profileId)
    if (!entry) return undefined

    entry.endTime = performance.now()
    entry.duration = entry.endTime - entry.startTime
    entry.memoryAfter = this.config.trackMemory ? this.getMemoryUsage() : undefined

    if (entry.memoryBefore !== undefined && entry.memoryAfter !== undefined) {
      entry.memoryDelta = entry.memoryAfter - entry.memoryBefore
    }

    if (error) {
      entry.status = "error"
      entry.error = error.message
    } else {
      entry.status = "completed"
    }

    // Remove from stack
    const stackIndex = this.profileStack.indexOf(entry)
    if (stackIndex !== -1) {
      this.profileStack.splice(stackIndex, 1)
    }

    this.activeProfiles.delete(profileId)

    // Only store root-level entries
    if (this.profileStack.length === 0 || !this.isDescendantOf(entry, this.profileStack[0])) {
      this.storeEntry(entry)
    }

    return entry
  }

  profile<T>(
    pluginId: string,
    operation: string,
    fn: () => T,
    metadata?: Record<string, unknown>
  ): T {
    const profileId = this.startProfile(pluginId, operation, metadata)

    try {
      const result = fn()
      this.endProfile(profileId)
      return result
    } catch (error) {
      this.endProfile(profileId, error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  async profileAsync<T>(
    pluginId: string,
    operation: string,
    fn: () => Promise<T>,
    metadata?: Record<string, unknown>
  ): Promise<T> {
    const profileId = this.startProfile(pluginId, operation, metadata)

    try {
      const result = await fn()
      this.endProfile(profileId)
      return result
    } catch (error) {
      this.endProfile(profileId, error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  // ===========================================================================
  // Resource Monitoring
  // ===========================================================================

  captureResourceSnapshot(pluginId: string): ResourceUsage {
    const usage: ResourceUsage = {
      memory: this.getMemoryUsage(),
      timestamp: Date.now(),
    }

    const snapshots = this.resourceSnapshots.get(pluginId) || []
    snapshots.push(usage)

    // Keep last 100 snapshots per plugin
    if (snapshots.length > 100) {
      snapshots.shift()
    }

    this.resourceSnapshots.set(pluginId, snapshots)
    return usage
  }

  getResourceHistory(pluginId: string): ResourceUsage[] {
    return this.resourceSnapshots.get(pluginId) || []
  }

  // ===========================================================================
  // Analysis
  // ===========================================================================

  getSummary(pluginId: string): ProfileSummary {
    const entries = this.entries.get(pluginId) || []
    const operationBreakdown: Record<string, OperationStats> = {}
    let totalDuration = 0
    let peakMemory = 0

    // Collect all entries including children
    const allEntries = this.flattenEntries(entries)

    for (const entry of allEntries) {
      if (!operationBreakdown[entry.operation]) {
        operationBreakdown[entry.operation] = {
          count: 0,
          totalDuration: 0,
          averageDuration: 0,
          minDuration: Infinity,
          maxDuration: 0,
          errorCount: 0,
        }
      }

      const stats = operationBreakdown[entry.operation]

      if (entry.status === "error") {
        stats.errorCount++
      }

      if (entry.status !== "completed") continue

      const duration = entry.duration || 0
      totalDuration += duration

      if (entry.memoryAfter !== undefined && entry.memoryAfter > peakMemory) {
        peakMemory = entry.memoryAfter
      }

      stats.count++
      stats.totalDuration += duration
      stats.averageDuration = stats.totalDuration / stats.count
      stats.minDuration = Math.min(stats.minDuration, duration)
      stats.maxDuration = Math.max(stats.maxDuration, duration)
    }

    // Calculate hotspots
    const hotspots: Hotspot[] = Object.entries(operationBreakdown)
      .map(([operation, stats]) => ({
        operation,
        percentage: totalDuration > 0 ? (stats.totalDuration / totalDuration) * 100 : 0,
        totalDuration: stats.totalDuration,
        count: stats.count,
      }))
      .sort((a, b) => b.percentage - a.percentage)
      .slice(0, 10)

    return {
      pluginId,
      totalOperations: allEntries.length,
      totalDuration,
      averageDuration: allEntries.length > 0 ? totalDuration / allEntries.length : 0,
      peakMemory,
      operationBreakdown,
      hotspots,
    }
  }

  getSlowOperations(pluginId: string, threshold: number): ProfileEntry[] {
    const entries = this.entries.get(pluginId) || []
    return this.flattenEntries(entries).filter(
      (e) => e.duration !== undefined && e.duration > threshold
    )
  }

  getErrorOperations(pluginId: string): ProfileEntry[] {
    const entries = this.entries.get(pluginId) || []
    return this.flattenEntries(entries).filter(
      (e): e is ProfileEntry & { status: "error" } => e.status === "error"
    )
  }

  // ===========================================================================
  // Flame Graph Data
  // ===========================================================================

  getFlameGraphData(pluginId: string): FlameNode[] {
    const entries = this.entries.get(pluginId) || []
    return entries.map((e) => this.entryToFlameNode(e))
  }

  private entryToFlameNode(entry: ProfileEntry): FlameNode {
    return {
      name: entry.operation,
      value: entry.duration || 0,
      children: entry.children.map((c) => this.entryToFlameNode(c)),
      metadata: {
        pluginId: entry.pluginId,
        status: entry.status,
        memoryDelta: entry.memoryDelta,
      },
    }
  }

  // ===========================================================================
  // Storage
  // ===========================================================================

  private storeEntry(entry: ProfileEntry): void {
    const pluginEntries = this.entries.get(entry.pluginId) || []
    pluginEntries.push(entry)

    // Trim if exceeds max
    if (pluginEntries.length > this.config.maxEntries) {
      pluginEntries.shift()
    }

    this.entries.set(entry.pluginId, pluginEntries)
  }

  getEntries(pluginId: string): ProfileEntry[] {
    return this.entries.get(pluginId) || []
  }

  clearEntries(pluginId?: string): void {
    if (pluginId) {
      this.entries.delete(pluginId)
      this.resourceSnapshots.delete(pluginId)
      this.activeSessions.delete(pluginId)
    } else {
      this.entries.clear()
      this.resourceSnapshots.clear()
      this.activeSessions.clear()
    }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private generateId(): string {
    return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  private shouldSample(): boolean {
    if (!this.config.enabled) return false
    if (this.config.sampleRate >= 1.0) return true
    return Math.random() < this.config.sampleRate
  }

  private getMemoryUsage(): number {
    if (typeof performance !== "undefined" && "memory" in performance) {
      return (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize || 0
    }
    return 0
  }

  private flattenEntries(entries: ProfileEntry[]): ProfileEntry[] {
    const result: ProfileEntry[] = []

    const flatten = (e: ProfileEntry) => {
      result.push(e)
      for (const child of e.children) {
        flatten(child)
      }
    }

    for (const entry of entries) {
      flatten(entry)
    }

    return result
  }

  private isDescendantOf(entry: ProfileEntry, root: ProfileEntry): boolean {
    const check = (parent: ProfileEntry): boolean => {
      if (parent.children.includes(entry)) return true
      return parent.children.some((c) => check(c))
    }
    return check(root)
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
  }

  isEnabled(): boolean {
    return this.config.enabled
  }
}

// =============================================================================
// Flame Graph Types
// =============================================================================

export interface FlameNode {
  name: string
  value: number
  children: FlameNode[]
  metadata?: Record<string, unknown>
}

// =============================================================================
// Singleton Instance
// =============================================================================

let profilerInstance: PluginProfiler | null = null

export function getPluginProfiler(config?: Partial<ProfilerConfig>): PluginProfiler {
  if (!profilerInstance) {
    profilerInstance = new PluginProfiler(config)
  }
  return profilerInstance
}

export function resetPluginProfiler(): void {
  profilerInstance = null
}

// =============================================================================
// Decorators / Helpers
// =============================================================================

export function withProfiling<T extends (...args: unknown[]) => unknown>(
  pluginId: string,
  operation: string,
  fn: T
): T {
  const profiler = getPluginProfiler()

  return ((...args: unknown[]) => {
    const result = fn(...args)

    if (result instanceof Promise) {
      return profiler.profileAsync(pluginId, operation, () => result as Promise<unknown>)
    }

    return profiler.profile(pluginId, operation, () => result)
  }) as T
}
