/**
 * Resolves the effective resilience policy for a plugin tool by merging the
 * global defaults with the manifest-level `resilience` block and the per-tool
 * `retryable` flag.
 *
 * Precedence (most specific wins): DEFAULT ← manifest.resilience ← toolDef —
 * except `timeoutMs`, where the manifest block stays the explicit backstop
 * and `toolDef.timeoutMs` only raises the floor when the manifest doesn't
 * set one. The tool's declared budget is its INTERNAL deadline (for a
 * cliTool, the child-process kill); the resilience timer must fire AFTER it
 * so the tool's own timeout error wins over the generic `TimeoutError`,
 * hence the slack. Without this a `cliTools[].timeoutMs` above the 30s
 * default was dead configuration — the resilience layer severed the call
 * first and the declared timeout never took effect.
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

/**
 * Slack added to a tool's declared `timeoutMs` when it becomes the
 * resilience backstop, so the tool's own timeout error (e.g. the
 * `CliToolExecutionError` a cliTool throws when `plugin_cli_exec` kills the
 * child) beats the generic resilience `TimeoutError` in the race. 15s
 * comfortably covers permission/consent and IPC latency inside an attempt.
 */
export const TOOL_TIMEOUT_SLACK_MS = 15_000

/**
 * Ceiling for a tool's declared timeout feeding the resilience floor —
 * matches the `plugin_cli_exec` 600s child-process ceiling. cliTool
 * manifests are validated against it; an imperative `registerTool`
 * definition that skips validation is clamped here instead so a huge
 * declared value can't inflate the resilience/relay budgets unboundedly.
 */
export const MAX_TOOL_TIMEOUT_MS = 600_000

export function resolveResilienceConfig(
  manifest: Pick<PluginManifest, "resilience">,
  toolDef?: Pick<PluginToolDef, "retryable" | "timeoutMs">
): ResolvedResilienceConfig {
  const r = manifest.resilience ?? {}
  const breaker = r.breaker ?? {}
  const retryable = toolDef?.retryable ?? r.retryable ?? DEFAULT_PLUGIN_RESILIENCE.retryable
  const maxRetries = retryable
    ? Math.max(0, r.maxRetries ?? DEFAULT_PLUGIN_RESILIENCE.maxRetries)
    : 0

  // `toolDef.timeoutMs` is the tool's internal deadline; the resilience
  // backstop must outlive it (+ slack) or it races the tool's own error.
  // Clamped at MAX_TOOL_TIMEOUT_MS — the `plugin_cli_exec` child ceiling —
  // so an unvalidated imperative def can't inflate the budgets unboundedly.
  const toolFloor =
    typeof toolDef?.timeoutMs === "number" &&
    Number.isFinite(toolDef.timeoutMs) &&
    toolDef.timeoutMs > 0
      ? Math.min(toolDef.timeoutMs, MAX_TOOL_TIMEOUT_MS) + TOOL_TIMEOUT_SLACK_MS
      : undefined

  return {
    timeoutMs: r.timeoutMs ?? toolFloor ?? DEFAULT_PLUGIN_RESILIENCE.timeoutMs,
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
