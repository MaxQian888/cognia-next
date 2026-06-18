/**
 * Fallback Chain Executor
 *
 * Executes a request against a primary provider and automatically
 * falls back to alternative providers on failure, respecting circuit
 * breaker state and configurable retry policy.
 */

import type { ModelMappingEntry } from "@/types/provider/model-mapping"
import type { CircuitBreakerStateValue } from "@/types/provider/circuit-breaker"
import { classifyProviderError, isTransientErrorClass } from "./error-classifier"

/** Result of a provider attempt */
export interface ProviderAttemptResult<T> {
  success: boolean
  data?: T
  error?: Error
  providerId: string
  modelId: string
  latencyMs: number
}

/** Dependencies for the fallback executor */
export interface FallbackExecutorDeps {
  /** Get circuit breaker state for a provider */
  getCircuitBreakerState: (providerId: string) => CircuitBreakerStateValue
  /** Record a successful request to the circuit breaker */
  recordSuccess: (providerId: string) => void
  /** Record a failed request to the circuit breaker */
  recordFailure: (providerId: string) => void
  /** Record metrics for health tracking */
  recordMetrics: (record: {
    providerId: string
    success: boolean
    latencyMs: number
    estimatedCostUsd?: number
    errorMessage?: string
  }) => void
}

/** Configuration for fallback behavior */
export interface FallbackConfig {
  /** Maximum number of fallback attempts */
  maxAttempts: number
  /** Request timeout in ms */
  timeoutMs: number
  /** HTTP status codes that should trigger fallback (default: 429, 500, 502, 503) */
  retryableStatusCodes: number[]
}

const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  maxAttempts: 3,
  timeoutMs: 30000,
  retryableStatusCodes: [429, 500, 502, 503],
}

/**
 * Execute a request with automatic fallback through a chain of providers.
 *
 * @param primary - The primary provider:model entry
 * @param fallbacks - Ordered fallback entries
 * @param executeFn - Function that executes the actual request for a given provider:model
 * @param deps - Circuit breaker and metrics dependencies
 * @param config - Fallback configuration overrides
 * @returns The result from the first successful provider, or the last error
 */
export async function executeFallbackChain<T>(
  primary: ModelMappingEntry,
  fallbacks: ModelMappingEntry[],
  executeFn: (providerId: string, modelId: string) => Promise<T>,
  deps: FallbackExecutorDeps,
  config: Partial<FallbackConfig> = {}
): Promise<ProviderAttemptResult<T>> {
  const cfg = { ...DEFAULT_FALLBACK_CONFIG, ...config }
  const allEntries = [primary, ...fallbacks]

  let lastResult: ProviderAttemptResult<T> | null = null
  let attempts = 0

  for (const entry of allEntries) {
    if (attempts >= cfg.maxAttempts) break

    // Skip providers with open circuit breakers
    const cbState = deps.getCircuitBreakerState(entry.providerId)
    if (cbState === "open") continue

    attempts++
    const startTime = Date.now()

    try {
      const data = await executeWithTimeout(
        executeFn(entry.providerId, entry.modelId),
        cfg.timeoutMs
      )

      const latencyMs = Date.now() - startTime

      // Record success
      deps.recordSuccess(entry.providerId)
      deps.recordMetrics({
        providerId: entry.providerId,
        success: true,
        latencyMs,
      })

      return {
        success: true,
        data,
        providerId: entry.providerId,
        modelId: entry.modelId,
        latencyMs,
      }
    } catch (error) {
      const latencyMs = Date.now() - startTime
      const err = error instanceof Error ? error : new Error(String(error))

      // Record failure
      deps.recordFailure(entry.providerId)
      deps.recordMetrics({
        providerId: entry.providerId,
        success: false,
        latencyMs,
        errorMessage: err.message,
      })

      lastResult = {
        success: false,
        error: err,
        providerId: entry.providerId,
        modelId: entry.modelId,
        latencyMs,
      }

      // Check if error is retryable
      if (!isRetryableError(err, cfg.retryableStatusCodes)) {
        // Non-retryable error (e.g., 401 auth error) — don't try other providers
        break
      }
    }
  }

  // All attempts failed
  return (
    lastResult || {
      success: false,
      error: new Error("No available providers in fallback chain"),
      providerId: primary.providerId,
      modelId: primary.modelId,
      latencyMs: 0,
    }
  )
}

/**
 * Execute a promise with a timeout
 */
function executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Request timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Check if an error is retryable (should trigger fallback to next provider).
 *
 * Delegates to the shared provider-error classifier (one taxonomy across
 * this executor and the renderer's routing-fallback path): transient
 * classes (rate-limit / timeout / network / server-error) retry; the
 * configured `retryableStatusCodes` remain an additional allowlist.
 * Special classes (context-window / content-policy) and permanent classes
 * (auth / invalid-request / unknown) do NOT retry here.
 */
function isRetryableError(error: Error, retryableStatusCodes: number[]): boolean {
  if (isTransientErrorClass(classifyProviderError(error.message))) return true

  const message = error.message.toLowerCase()
  for (const code of retryableStatusCodes) {
    if (message.includes(String(code))) return true
  }
  return false
}
