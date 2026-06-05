// Client-side rate limiter for the pet's LLM speak side channel: a minimum
// interval between calls plus a sliding per-minute cap, so a click-happy user
// can't spend tokens faster than the bubble can even display. Pure factory
// with an injected clock (the caller passes `now`) — the project's standard
// testable-time pattern. A module-level singleton shares the budget across
// every talk source (widget panel, overlay bridge).

export interface SpeakLimiterConfig {
  /** Minimum ms between accepted calls. */
  minIntervalMs: number
  /** Maximum accepted calls inside any trailing 60s window. */
  maxPerMinute: number
}

export interface SpeakLimiter {
  /** Try to consume one slot at `now`. True = allowed (and recorded). */
  tryAcquire: (now: number) => boolean
}

const WINDOW_MS = 60_000

export const DEFAULT_SPEAK_LIMITER_CONFIG: SpeakLimiterConfig = {
  minIntervalMs: 3000,
  maxPerMinute: 8,
}

export function createSpeakLimiter(
  config: SpeakLimiterConfig = DEFAULT_SPEAK_LIMITER_CONFIG
): SpeakLimiter {
  let acceptedAt: number[] = []

  return {
    tryAcquire(now: number): boolean {
      acceptedAt = acceptedAt.filter((ts) => now - ts < WINDOW_MS)
      const last = acceptedAt[acceptedAt.length - 1]
      if (last !== undefined && now - last < config.minIntervalMs) return false
      if (acceptedAt.length >= config.maxPerMinute) return false
      acceptedAt.push(now)
      return true
    },
  }
}

let singleton: SpeakLimiter | null = null

/** Shared limiter across all talk sources. */
export function getSpeakLimiter(): SpeakLimiter {
  if (!singleton) singleton = createSpeakLimiter()
  return singleton
}

export function __resetSpeakLimiterForTesting(): void {
  singleton = null
}
