/**
 * LRU Cache for rendered LaTeX formulas
 * Reduces redundant KaTeX rendering calls for repeated formulas
 */

import katex from "katex"
import { getKatexOptions, MATH_CACHE_MAX_SIZE, MATH_CACHE_MAX_AGE } from "./config"

interface CacheEntry {
  html: string
  timestamp: number
  accessCount: number
}

class MathCache {
  private cache: Map<string, CacheEntry> = new Map()
  private maxSize: number
  private maxAge: number
  private hits = 0
  private misses = 0

  constructor(maxSize = MATH_CACHE_MAX_SIZE, maxAge = MATH_CACHE_MAX_AGE) {
    this.maxSize = maxSize
    this.maxAge = maxAge
  }

  private getCacheKey(latex: string, displayMode: boolean): string {
    return `${displayMode ? "D" : "I"}:${latex}`
  }

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.timestamp > this.maxAge
  }

  private evictIfNeeded(): void {
    if (this.cache.size < this.maxSize) return

    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.maxAge) {
        this.cache.delete(key)
      }
    }

    if (this.cache.size >= this.maxSize) {
      const entries = Array.from(this.cache.entries())
      entries.sort((a, b) => {
        const countDiff = a[1].accessCount - b[1].accessCount
        if (countDiff !== 0) return countDiff
        return a[1].timestamp - b[1].timestamp
      })

      const removeCount = Math.ceil(this.maxSize * 0.2)
      for (let i = 0; i < removeCount && i < entries.length; i++) {
        this.cache.delete(entries[i][0])
      }
    }
  }

  get(latex: string, displayMode: boolean): string | null {
    const key = this.getCacheKey(latex, displayMode)
    const entry = this.cache.get(key)

    if (!entry) {
      this.misses++
      return null
    }
    if (this.isExpired(entry)) {
      this.cache.delete(key)
      this.misses++
      return null
    }

    entry.accessCount++
    entry.timestamp = Date.now()
    this.hits++
    return entry.html
  }

  set(latex: string, displayMode: boolean, html: string): void {
    this.evictIfNeeded()
    const key = this.getCacheKey(latex, displayMode)
    this.cache.set(key, {
      html,
      timestamp: Date.now(),
      accessCount: 1,
    })
  }

  has(latex: string, displayMode: boolean): boolean {
    const key = this.getCacheKey(latex, displayMode)
    const entry = this.cache.get(key)
    if (!entry) return false
    if (this.isExpired(entry)) {
      this.cache.delete(key)
      return false
    }
    return true
  }

  clear(): void {
    this.cache.clear()
    this.hits = 0
    this.misses = 0
  }

  getStats() {
    const total = this.hits + this.misses
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: total === 0 ? 0 : this.hits / total,
      hits: this.hits,
      misses: this.misses,
    }
  }
}

const globalMathCache = new MathCache()

export function renderMathCached(
  latex: string,
  displayMode: boolean,
  options: { trust?: boolean } = {}
): string {
  const cached = globalMathCache.get(latex, displayMode)
  if (cached !== null) {
    return cached
  }

  const katexOptions = getKatexOptions(displayMode, options)
  const html = katex.renderToString(latex, katexOptions)
  globalMathCache.set(latex, displayMode, html)
  return html
}

export function renderMathSafe(
  latex: string,
  displayMode: boolean,
  options: { trust?: boolean } = {}
): { html: string; error: string | null } {
  try {
    const html = renderMathCached(latex, displayMode, options)
    return { html, error: null }
  } catch (err) {
    return {
      html: "",
      error: err instanceof Error ? err.message : "Failed to render math",
    }
  }
}

export function clearMathCache(): void {
  globalMathCache.clear()
}

export function getMathCacheStats() {
  return globalMathCache.getStats()
}

export { globalMathCache, MathCache }
