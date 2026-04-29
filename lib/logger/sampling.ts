/**
 * Log Sampling
 * Rate limiting and sampling for high-frequency log sources
 */

import type { LogLevel } from "./types"

/**
 * Sampling configuration for a module
 */
interface SamplingConfig {
  /** Sampling rate (0-1, 1 = 100%) */
  rate: number
  /** Minimum interval between same messages (ms) */
  minInterval?: number
  /** Maximum burst count before throttling */
  burstLimit?: number
}

/**
 * Default sampling configurations by module pattern
 */
const DEFAULT_SAMPLING: Record<string, SamplingConfig> = {
  // High-frequency events - aggressive sampling
  mouse: { rate: 0.01, minInterval: 100 },
  keyboard: { rate: 0.1, minInterval: 50 },
  scroll: { rate: 0.05, minInterval: 100 },
  resize: { rate: 0.1, minInterval: 200 },
  animation: { rate: 0.01, minInterval: 16 },

  // Medium-frequency events
  network: { rate: 0.5 },
  state: { rate: 0.5 },
  render: { rate: 0.2 },

  // Always log
  error: { rate: 1.0 },
  auth: { rate: 1.0 },
  security: { rate: 1.0 },

  // Default
  default: { rate: 1.0 },
}

/**
 * Message deduplication cache
 */
interface DedupeEntry {
  count: number
  firstSeen: number
  lastSeen: number
}

const dedupeCache = new Map<string, DedupeEntry>()
const DEDUPE_WINDOW = 5000 // 5 seconds
const DEDUPE_MAX_ENTRIES = 1000

/**
 * Log sampler class
 */
class LogSampler {
  private config: Record<string, SamplingConfig>
  private lastLogTime: Map<string, number> = new Map()
  private burstCount: Map<string, number> = new Map()

  constructor(config?: Record<string, SamplingConfig>) {
    this.config = { ...DEFAULT_SAMPLING, ...config }
  }

  /**
   * Update sampling configuration
   */
  updateConfig(config: Record<string, SamplingConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * Get sampling config for a module
   */
  private getConfig(module: string): SamplingConfig {
    // Check exact match
    if (this.config[module]) {
      return this.config[module]
    }

    // Check prefix match
    for (const key of Object.keys(this.config)) {
      if (module.startsWith(key)) {
        return this.config[key]
      }
    }

    return this.config["default"] || { rate: 1.0 }
  }

  /**
   * Check if a log should be sampled (included)
   */
  shouldLog(module: string, level: LogLevel, _message?: string): boolean {
    // Always log errors and above
    if (level === "error" || level === "fatal") {
      return true
    }

    const config = this.getConfig(module)
    const key = `${module}:${level}`

    // Check minimum interval
    if (config.minInterval) {
      const lastTime = this.lastLogTime.get(key) || 0
      const now = Date.now()
      if (now - lastTime < config.minInterval) {
        return false
      }
      this.lastLogTime.set(key, now)
    }

    // Check burst limit
    if (config.burstLimit) {
      const count = this.burstCount.get(key) || 0
      if (count >= config.burstLimit) {
        // Reset after 1 second
        setTimeout(() => this.burstCount.set(key, 0), 1000)
        return false
      }
      this.burstCount.set(key, count + 1)
    }

    // Random sampling
    return Math.random() < config.rate
  }

  /**
   * Check for duplicate messages and aggregate
   */
  checkDedupe(
    module: string,
    level: LogLevel,
    message: string
  ): {
    shouldLog: boolean
    count?: number
  } {
    const key = `${module}:${level}:${message}`
    const now = Date.now()

    // Cleanup old entries
    if (dedupeCache.size > DEDUPE_MAX_ENTRIES) {
      const cutoff = now - DEDUPE_WINDOW
      for (const [k, v] of dedupeCache.entries()) {
        if (v.lastSeen < cutoff) {
          dedupeCache.delete(k)
        }
      }
    }

    const existing = dedupeCache.get(key)
    if (existing && now - existing.lastSeen < DEDUPE_WINDOW) {
      existing.count++
      existing.lastSeen = now

      // Log aggregated message every 10 duplicates or every 5 seconds
      if (existing.count % 10 === 0 || now - existing.firstSeen >= 5000) {
        const count = existing.count
        dedupeCache.delete(key)
        return { shouldLog: true, count }
      }

      return { shouldLog: false }
    }

    dedupeCache.set(key, {
      count: 1,
      firstSeen: now,
      lastSeen: now,
    })

    return { shouldLog: true }
  }

  /**
   * Reset all sampling state
   */
  reset(): void {
    this.lastLogTime.clear()
    this.burstCount.clear()
    dedupeCache.clear()
  }
}

/**
 * Singleton sampler instance
 */
export const logSampler = new LogSampler()

/**
 * Configure sampling for specific modules
 */
export function configureSampling(config: Record<string, SamplingConfig>): void {
  logSampler.updateConfig(config)
}

/**
 * Convert sampling rate to percentage config
 */
export function samplingRate(rate: number): SamplingConfig {
  return { rate: Math.max(0, Math.min(1, rate)) }
}
