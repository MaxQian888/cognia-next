/**
 * Plugin resilience telemetry — the read model behind the resilience layer.
 *
 * Aggregates, per plugin:
 *   - load stats (attempts / retries / last error / last success)
 *   - activation-failure history (bounded ring, reused `createBoundedBuffer`)
 *   - circuit-breaker snapshots (pulled from the reused breaker registry)
 *
 * Pure module-level state with injected timestamps (no `Date.now`), mirroring
 * the `hooks-system` ring-buffer pattern. A future Settings panel — or a
 * devtools console call — reads `getPluginResilienceSnapshot()`; this round
 * ships the data layer only, with activation failures also routed into the
 * existing Audit panel via the manager's `recordSilentFailure`.
 */

import type { CircuitBreakerSnapshot } from "@/lib/connectors/circuit-breaker"
import {
  activationBreakerKey,
  loadBreakerKey,
  snapshotKey,
} from "@/lib/plugin/resilience/breaker-registry"
import { createBoundedBuffer } from "@/lib/utils/bounded-buffer"

export interface PluginActivationFailureRecord {
  pluginId: string
  event: string
  message: string
  at: number
}

export interface PluginLoadStats {
  attempts: number
  retries: number
  lastError: { message: string; at: number } | null
  lastSuccessAt: number | null
}

export interface PluginResilienceSnapshot {
  pluginId: string
  load: PluginLoadStats
  loadBreaker: CircuitBreakerSnapshot | null
  activationBreaker: CircuitBreakerSnapshot | null
  recentActivationFailures: PluginActivationFailureRecord[]
}

const ACTIVATION_FAILURE_CAP = 256
const activationFailures =
  createBoundedBuffer<PluginActivationFailureRecord>(ACTIVATION_FAILURE_CAP)
const loadStats = new Map<string, PluginLoadStats>()

function emptyStats(): PluginLoadStats {
  return { attempts: 0, retries: 0, lastError: null, lastSuccessAt: null }
}

function ensureStats(pluginId: string): PluginLoadStats {
  let stats = loadStats.get(pluginId)
  if (!stats) {
    stats = emptyStats()
    loadStats.set(pluginId, stats)
  }
  return stats
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── Activation failures ─────────────────────────────────────────────────────

export function recordActivationFailure(
  pluginId: string,
  event: string,
  error: unknown,
  at: number
): void {
  activationFailures.push({ pluginId, event, message: messageOf(error), at })
}

export function getRecentActivationFailures(): readonly PluginActivationFailureRecord[] {
  return activationFailures.toArray()
}

// ── Load stats ──────────────────────────────────────────────────────────────

export function recordLoadAttempt(pluginId: string): void {
  ensureStats(pluginId).attempts += 1
}

export function recordLoadRetry(pluginId: string): void {
  ensureStats(pluginId).retries += 1
}

export function recordLoadSuccess(pluginId: string, at: number): void {
  const stats = ensureStats(pluginId)
  stats.lastSuccessAt = at
  stats.lastError = null
}

export function recordLoadFailure(pluginId: string, error: unknown, at: number): void {
  const stats = ensureStats(pluginId)
  stats.lastError = { message: messageOf(error), at }
}

// ── Aggregated read model ────────────────────────────────────────────────────

export function getPluginResilienceSnapshot(pluginId: string): PluginResilienceSnapshot {
  return {
    pluginId,
    load: { ...(loadStats.get(pluginId) ?? emptyStats()) },
    loadBreaker: snapshotKey(loadBreakerKey(pluginId)),
    activationBreaker: snapshotKey(activationBreakerKey(pluginId)),
    recentActivationFailures: activationFailures
      .toArray()
      .filter((rec) => rec.pluginId === pluginId),
  }
}

/** Test-only: clear all telemetry state. */
export function __resetResilienceTelemetryForTesting(): void {
  activationFailures.clear()
  loadStats.clear()
}
