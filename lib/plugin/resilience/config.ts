/**
 * Resolves the effective resilience policy for a plugin tool by merging the
 * global defaults with the manifest-level `resilience` block and the per-tool
 * `retryable` flag.
 *
 * Precedence (most specific wins): DEFAULT ← manifest.resilience ← toolDef.
 * Retry stays OFF unless explicitly opted in — when neither manifest nor tool
 * enables it, `maxRetries` is clamped to 0 (the non-idempotency guard).
 */

import { isRetryable as baseIsRetryable } from "@/lib/queue/retry-policy"
import type { PluginManifest, PluginToolDef } from "@/types/plugin/plugin"

import type { PluginBreakerConfig } from "./breaker-registry"

export interface ResolvedResilienceConfig {
  timeoutMs: number
  maxRetries: number
  retryable: boolean
  breakerScope: "tool" | "plugin"
  breaker: Pick<PluginBreakerConfig, "failureThreshold" | "cooldownMs" | "successThreshold">
}

export const DEFAULT_PLUGIN_RESILIENCE: ResolvedResilienceConfig = {
  timeoutMs: 30_000,
  maxRetries: 0,
  retryable: false,
  breakerScope: "tool",
  breaker: { failureThreshold: 5, cooldownMs: 30_000, successThreshold: 2 },
}

/**
 * The sidecar wraps each plugin tool IPC round-trip in a 120s ceiling
 * (`sidecar/dispatch/ai-sdk-tools.mjs`). The renderer-side budget must stay
 * under it or the IPC layer times out first.
 */
export const SIDECAR_IPC_TIMEOUT_MS = 120_000

export function resolveResilienceConfig(
  manifest: Pick<PluginManifest, "resilience">,
  toolDef?: Pick<PluginToolDef, "retryable">
): ResolvedResilienceConfig {
  const r = manifest.resilience ?? {}
  const breaker = r.breaker ?? {}
  const retryable = toolDef?.retryable ?? r.retryable ?? DEFAULT_PLUGIN_RESILIENCE.retryable
  const maxRetries = retryable
    ? Math.max(0, r.maxRetries ?? DEFAULT_PLUGIN_RESILIENCE.maxRetries)
    : 0

  return {
    timeoutMs: r.timeoutMs ?? DEFAULT_PLUGIN_RESILIENCE.timeoutMs,
    maxRetries,
    retryable,
    breakerScope: r.breakerScope ?? DEFAULT_PLUGIN_RESILIENCE.breakerScope,
    breaker: {
      failureThreshold:
        breaker.failureThreshold ?? DEFAULT_PLUGIN_RESILIENCE.breaker.failureThreshold,
      cooldownMs: breaker.cooldownMs ?? DEFAULT_PLUGIN_RESILIENCE.breaker.cooldownMs,
      successThreshold:
        breaker.successThreshold ?? DEFAULT_PLUGIN_RESILIENCE.breaker.successThreshold,
    },
  }
}

/**
 * Resilience policy for plugin module LOAD. Unlike tool execution, loading a
 * module is idempotent (no side effects), so retry is ON by default and
 * independent of the per-tool `retryable` opt-in.
 */
export const LOAD_RESILIENCE = {
  timeoutMs: 30_000,
  maxRetries: 2,
  breaker: { failureThreshold: 3, cooldownMs: 30_000, successThreshold: 1 },
} as const

/** Load failures that are permanent and must NOT be retried. */
const NON_RETRYABLE_LOAD_PATTERNS: readonly RegExp[] = [
  /does not export/i,
  /unknown plugin type/i,
  /signature/i,
  /invalid plugin manifest/i,
  /incompatible plugin/i,
]

/**
 * Domain retryability predicate for plugin loads — layered on the shared
 * sentinel patterns plus load-specific permanent failures. Passed to
 * `runResilient({ isRetryable })`.
 */
export function isRetryableLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (NON_RETRYABLE_LOAD_PATTERNS.some((re) => re.test(msg))) return false
  return baseIsRetryable(err)
}

/**
 * Worst-case budget check. Returns a warning string when timeout × attempts
 * meets or exceeds the sidecar IPC ceiling, otherwise null.
 */
export function checkResilienceBudget(cfg: ResolvedResilienceConfig): string | null {
  const attempts = cfg.maxRetries + 1
  const worst = cfg.timeoutMs * attempts
  if (worst >= SIDECAR_IPC_TIMEOUT_MS) {
    return `plugin resilience budget ${worst}ms (timeoutMs ${cfg.timeoutMs} × ${attempts} attempts) meets/exceeds the ${SIDECAR_IPC_TIMEOUT_MS}ms sidecar IPC ceiling`
  }
  return null
}
