/**
 * Non-persisted, per-plugin activation progress (ADR-0096).
 *
 * Plain `create()` — **no `persist` middleware at all**, so there is no
 * `partialize` to get wrong. Progress is inherently transient: the persisted
 * plugin status in `plugin-store.ts` stays authoritative, and
 * `normalizePersistedPluginStatus` already collapses every transitional status
 * on reload. A half-finished activation must never survive a restart.
 *
 * # Invariants live here, not at the call sites
 *
 * `manager.ts` is 4800 lines and `enablePluginInner` is its most contended
 * function. Every mutator below is defensive so the nine instrumentation calls
 * can be plain side effects that cannot throw, cannot corrupt state, and cannot
 * resurrect a finished entry:
 *
 * - `advance` no-ops on an unknown key (an already-enabled early return never
 *   created one), never moves backwards, and no-ops after a terminal status.
 * - `fail` / `cancel` keep `phase` and `processed` exactly where they were and
 *   only flip `status`. That *is* "failure reports the current phase".
 * - `begin` replaces an existing entry wholesale and cancels any pending clear
 *   timer, so a retry after failure is not deleted by the previous attempt's
 *   scheduled cleanup.
 */

import { create } from "zustand"

import {
  PLUGIN_ACTIVATION_TOTAL,
  processedForPhase,
  type PluginActivationPhase,
  type PluginActivationProgress,
} from "@/lib/plugin/core/activation-phases"

/**
 * How long a finished entry stays visible.
 *
 * `completed` outlives `LOADING_MIN_DISPLAY_MS` (320ms) so the bar visibly
 * lands on 7/7 rather than vanishing mid-animation. Terminal states linger
 * longer so the failed phase can be read alongside the error toast.
 */
export const ACTIVATION_PROGRESS_COMPLETED_RETENTION_MS = 600
export const ACTIVATION_PROGRESS_TERMINAL_RETENTION_MS = 4000

export interface PluginActivationProgressState {
  byPluginId: Record<string, PluginActivationProgress>
}

export const usePluginActivationProgressStore = create<PluginActivationProgressState>(() => ({
  byPluginId: {},
}))

export interface PluginActivationProgressDeps {
  scheduleClear: (fn: () => void, ms: number) => () => void
  now: () => number
}

const defaultDeps: PluginActivationProgressDeps = {
  scheduleClear: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  },
  now: () => Date.now(),
}

let deps: PluginActivationProgressDeps = defaultDeps
const clearTimers = new Map<string, () => void>()

export function configurePluginActivationProgressStore(
  next: Partial<PluginActivationProgressDeps> | null
): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps
}

function cancelPendingClear(pluginId: string): void {
  clearTimers.get(pluginId)?.()
  clearTimers.delete(pluginId)
}

function scheduleRemoval(pluginId: string, ms: number): void {
  cancelPendingClear(pluginId)
  const cancel = deps.scheduleClear(() => {
    clearTimers.delete(pluginId)
    usePluginActivationProgressStore.setState((state) => {
      if (!(pluginId in state.byPluginId)) return state
      const { [pluginId]: _removed, ...rest } = state.byPluginId
      void _removed
      return { byPluginId: rest }
    })
  }, ms)
  clearTimers.set(pluginId, cancel)
}

function patch(
  pluginId: string,
  update: (current: PluginActivationProgress) => PluginActivationProgress | null
): void {
  usePluginActivationProgressStore.setState((state) => {
    const current = state.byPluginId[pluginId]
    if (!current) return state
    const next = update(current)
    if (!next) return state
    return { byPluginId: { ...state.byPluginId, [pluginId]: next } }
  })
}

export function beginPluginActivationProgress(
  pluginId: string,
  opts: { reason?: string; parentPluginId?: string } = {}
): void {
  cancelPendingClear(pluginId)
  const startedAt = deps.now()
  usePluginActivationProgressStore.setState((state) => ({
    byPluginId: {
      ...state.byPluginId,
      [pluginId]: {
        pluginId,
        phase: "preflight",
        processed: processedForPhase("preflight"),
        total: PLUGIN_ACTIVATION_TOTAL,
        status: "running",
        reason: opts.reason,
        parentPluginId: opts.parentPluginId,
        startedAt,
        updatedAt: startedAt,
      },
    },
  }))
}

export function advancePluginActivationProgress(
  pluginId: string,
  phase: PluginActivationPhase
): void {
  patch(pluginId, (current) => {
    if (current.status !== "running") return null
    const processed = processedForPhase(phase)
    // Never move backwards. An out-of-order call is a bug, but it must not
    // make the bar jump back and it must not be able to throw.
    if (processed < current.processed) return null
    return { ...current, phase, processed, updatedAt: deps.now() }
  })
}

export function completePluginActivationProgress(pluginId: string): void {
  patch(pluginId, (current) => {
    if (current.status !== "running") return null
    return {
      ...current,
      processed: PLUGIN_ACTIVATION_TOTAL,
      status: "completed",
      updatedAt: deps.now(),
    }
  })
  scheduleRemoval(pluginId, ACTIVATION_PROGRESS_COMPLETED_RETENTION_MS)
}

export function failPluginActivationProgress(pluginId: string, error: unknown): void {
  patch(pluginId, (current) => {
    if (current.status !== "running") return null
    // phase and processed are deliberately untouched: the entry records where
    // the activation actually stopped.
    return {
      ...current,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      updatedAt: deps.now(),
    }
  })
  scheduleRemoval(pluginId, ACTIVATION_PROGRESS_TERMINAL_RETENTION_MS)
}

export function cancelPluginActivationProgress(pluginId: string, reason: string): void {
  patch(pluginId, (current) => {
    if (current.status !== "running") return null
    return { ...current, status: "cancelled", reason, updatedAt: deps.now() }
  })
  scheduleRemoval(pluginId, ACTIVATION_PROGRESS_TERMINAL_RETENTION_MS)
}

export function getPluginActivationProgress(
  pluginId: string
): PluginActivationProgress | undefined {
  return usePluginActivationProgressStore.getState().byPluginId[pluginId]
}

export function __resetPluginActivationProgressStoreForTesting(): void {
  for (const cancel of clearTimers.values()) cancel()
  clearTimers.clear()
  deps = defaultDeps
  usePluginActivationProgressStore.setState({ byPluginId: {} })
}
