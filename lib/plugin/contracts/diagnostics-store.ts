/**
 * Central aggregator for plugin-point diagnostics across UI slot, hook, and
 * activation sources. Consumed by the plugin diagnostics panel to render a
 * unified view per plugin.
 */

import { loggers } from "../core/logger"
import type { PluginPointDiagnostic } from "./plugin-points"

const diagnosticsByPlugin = new Map<string, PluginPointDiagnostic[]>()
const listeners = new Set<() => void>()
let revision = 0

// Cached snapshot for `getAllPluginPointDiagnostics`. `useSyncExternalStore`
// requires getSnapshot to return a referentially-stable value while the store
// is unchanged; rebuilding a fresh object every call makes React detect a new
// snapshot on every render and loop forever ("getSnapshot should be cached").
// The cache is keyed by `revision` so it invalidates exactly on each notify().
let snapshotCache: Record<string, PluginPointDiagnostic[]> | null = null
let snapshotCacheRevision = -1

function notify(): void {
  revision += 1
  for (const listener of listeners) {
    listener()
  }
}

export function recordPluginPointDiagnostic(
  pluginId: string,
  diagnostic: PluginPointDiagnostic
): void {
  const existing = diagnosticsByPlugin.get(pluginId) || []
  existing.push(diagnostic)
  // Ring buffer (W6.7): a chatty failure site (retry loop, per-chunk hook)
  // previously grew this unboundedly across a long session. Mirrors the
  // 100-entry cap in tools-bridge.ts.
  if (existing.length > MAX_DIAGNOSTICS_PER_PLUGIN) {
    existing.splice(0, existing.length - MAX_DIAGNOSTICS_PER_PLUGIN)
  }
  diagnosticsByPlugin.set(pluginId, existing)
  notify()
}

/** Per-plugin diagnostics retention (ring buffer, W6.7). */
export const MAX_DIAGNOSTICS_PER_PLUGIN = 100

export function getPluginPointDiagnostics(pluginId: string): PluginPointDiagnostic[] {
  return [...(diagnosticsByPlugin.get(pluginId) || [])]
}

export function getAllPluginPointDiagnostics(): Record<string, PluginPointDiagnostic[]> {
  if (snapshotCache !== null && snapshotCacheRevision === revision) {
    return snapshotCache
  }
  const out: Record<string, PluginPointDiagnostic[]> = {}
  for (const [pluginId, diagnostics] of diagnosticsByPlugin.entries()) {
    out[pluginId] = [...diagnostics]
  }
  snapshotCache = out
  snapshotCacheRevision = revision
  return out
}

export function clearPluginPointDiagnostics(pluginId: string): void {
  if (diagnosticsByPlugin.delete(pluginId)) {
    notify()
  }
}

export function clearAllPluginPointDiagnostics(): void {
  if (diagnosticsByPlugin.size === 0) return
  diagnosticsByPlugin.clear()
  notify()
}

export function subscribePluginPointDiagnostics(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getPluginPointDiagnosticsRevision(): number {
  return revision
}

export interface SilentFailureContext {
  /** Call-site identifier, e.g. "manager.syncBackendStatus". */
  site: string
  /** Short, user-readable description. */
  message: string
  /**
   * Whether the failure is structurally expected. Web mode without a
   * Tauri backend → true (debug log only). Desktop runtime failure → false
   * (warn log + diagnostics-store entry surfaced in the Audit panel).
   */
  expected: boolean
}

export function recordSilentFailure(
  pluginId: string,
  ctx: SilentFailureContext,
  error: unknown
): void {
  const errMsg = error instanceof Error ? error.message : String(error)
  if (ctx.expected) {
    loggers.manager.debug(`[silent:${ctx.site}] ${ctx.message}`, errMsg)
    return
  }
  loggers.manager.warn(`[silent:${ctx.site}] ${ctx.message}`, errMsg)
  recordPluginPointDiagnostic(pluginId, {
    code: "plugin.silent-failure",
    severity: "warning",
    message: ctx.message,
    pointKind: "runtime",
    pointId: ctx.site,
    hint: errMsg,
  })
}

// =============================================================================
// Test-only helpers (PR-E)
// =============================================================================

/**
 * Drops every recorded diagnostic + every subscription + resets the
 * revision counter. PR-E added this so tests don't have to
 * `vi.resetModules()` or remember to call `clearAllPluginPointDiagnostics`
 * + the (no-op-for-listeners) `unsubscribe` separately. Throws
 * outside NODE_ENV=test so production code can't drop diagnostics by
 * mistake.
 *
 * The diagnostics store stays as module-level state on purpose —
 * 25+ callers reach for `recordSilentFailure` / `recordPluginPointDiagnostic`
 * by name and a factory wrap would force a churn-heavy parameter
 * threading without a measurable benefit. See PR-E in
 * `plans/noble-hatching-mango.md` for the deviation rationale.
 */
export function __resetDiagnosticsStoreForTesting(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetDiagnosticsStoreForTesting is only callable in NODE_ENV=test")
  }
  diagnosticsByPlugin.clear()
  listeners.clear()
  revision = 0
  snapshotCache = null
  snapshotCacheRevision = -1
}
