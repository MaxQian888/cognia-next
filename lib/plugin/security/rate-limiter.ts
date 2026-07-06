/**
 * Plugin Rate Limiter
 *
 * Token-bucket based rate limits for plugin API operations.
 */

export interface RateLimitConfig {
  capacity: number
  refillPerSecond: number
}

export class RateLimitError extends Error {
  public readonly pluginId: string
  public readonly operation: string

  constructor(pluginId: string, operation: string) {
    super(`Rate limit exceeded for ${operation}`)
    this.name = "RateLimitError"
    this.pluginId = pluginId
    this.operation = operation
  }
}

interface TokenBucket {
  tokens: number
  lastRefill: number
}

export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  "network:fetch": { capacity: 60, refillPerSecond: 1 },
  "network:search": { capacity: 30, refillPerSecond: 0.5 },
  "network:download": { capacity: 20, refillPerSecond: 0.3 },
  "network:upload": { capacity: 20, refillPerSecond: 0.3 },
  "fs:read": { capacity: 120, refillPerSecond: 2 },
  "fs:write": { capacity: 60, refillPerSecond: 1 },
  "fs:delete": { capacity: 30, refillPerSecond: 0.5 },
  "shell:execute": { capacity: 10, refillPerSecond: 0.2 },
  "process:spawn": { capacity: 5, refillPerSecond: 0.1 },
  "db:query": { capacity: 120, refillPerSecond: 2 },
  "db:execute": { capacity: 60, refillPerSecond: 1 },
  "clipboard:read": { capacity: 60, refillPerSecond: 1 },
  "clipboard:write": { capacity: 60, refillPerSecond: 1 },
  "python:call": { capacity: 30, refillPerSecond: 0.5 },
  "python:eval": { capacity: 10, refillPerSecond: 0.2 },
  "python:import": { capacity: 10, refillPerSecond: 0.2 },
  "ui:notification": { capacity: 30, refillPerSecond: 0.5 },
  "pet:interact": { capacity: 10, refillPerSecond: 0.5 },
  "pet:emit": { capacity: 20, refillPerSecond: 0.5 },
}

export class PluginRateLimiter {
  private limits: Record<string, RateLimitConfig>
  private buckets: Map<string, Map<string, TokenBucket>> = new Map()

  constructor(limits: Record<string, RateLimitConfig> = DEFAULT_RATE_LIMITS) {
    this.limits = { ...limits }
  }

  check(pluginId: string, operation: string): void {
    const limit = this.limits[operation]
    if (!limit) return

    const bucket = this.getBucket(pluginId, operation, limit)
    this.refill(bucket, limit)

    if (bucket.tokens < 1) {
      throw new RateLimitError(pluginId, operation)
    }

    bucket.tokens -= 1
  }

  setLimit(operation: string, config: RateLimitConfig): void {
    this.limits = { ...this.limits, [operation]: config }
  }

  getLimit(operation: string): RateLimitConfig | undefined {
    return this.limits[operation]
  }

  reset(pluginId?: string): void {
    if (!pluginId) {
      this.buckets.clear()
      return
    }

    this.buckets.delete(pluginId)
  }

  private getBucket(pluginId: string, operation: string, config: RateLimitConfig): TokenBucket {
    let pluginBuckets = this.buckets.get(pluginId)
    if (!pluginBuckets) {
      pluginBuckets = new Map()
      this.buckets.set(pluginId, pluginBuckets)
    }

    let bucket = pluginBuckets.get(operation)
    if (!bucket) {
      bucket = { tokens: config.capacity, lastRefill: Date.now() }
      pluginBuckets.set(operation, bucket)
    }

    return bucket
  }

  private refill(bucket: TokenBucket, config: RateLimitConfig): void {
    const now = Date.now()
    const elapsedSeconds = (now - bucket.lastRefill) / 1000
    if (elapsedSeconds <= 0) return

    const refillTokens = elapsedSeconds * config.refillPerSecond
    bucket.tokens = Math.min(config.capacity, bucket.tokens + refillTokens)
    bucket.lastRefill = now
  }
}

let rateLimiterInstance: PluginRateLimiter | null = null

export function getPluginRateLimiter(
  limits: Record<string, RateLimitConfig> = DEFAULT_RATE_LIMITS
): PluginRateLimiter {
  if (!rateLimiterInstance) {
    rateLimiterInstance = new PluginRateLimiter(limits)
  }
  return rateLimiterInstance
}

export function resetPluginRateLimiter(): void {
  rateLimiterInstance = null
}
