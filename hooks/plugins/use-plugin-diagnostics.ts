"use client"

// Subscribe to the diagnostics-store for a single plugin id. Wraps
// `subscribePluginPointDiagnostics` in `useSyncExternalStore` so the detail
// header can show real-time error/warning entries without polling.
//
// IMPORTANT: `useSyncExternalStore` compares snapshots by reference. The
// underlying store returns a fresh array on every read, so we cache the
// array per (pluginId, revision) to keep the reference stable between
// notifications — otherwise React detects a "change" on every render and
// loops infinitely.

import { useCallback, useSyncExternalStore } from "react"
import {
  getPluginPointDiagnostics,
  getPluginPointDiagnosticsRevision,
  subscribePluginPointDiagnostics,
} from "@/lib/plugin/contracts/diagnostics-store"
import type { PluginPointDiagnostic } from "@/lib/plugin/contracts/plugin-points"

const cache = new Map<string, { revision: number; snapshot: PluginPointDiagnostic[] }>()

function readStableSnapshot(pluginId: string): PluginPointDiagnostic[] {
  const revision = getPluginPointDiagnosticsRevision()
  const cached = cache.get(pluginId)
  if (cached && cached.revision === revision) return cached.snapshot
  const snapshot = getPluginPointDiagnostics(pluginId)
  cache.set(pluginId, { revision, snapshot })
  return snapshot
}

export function usePluginDiagnostics(pluginId: string): PluginPointDiagnostic[] {
  const subscribe = useCallback(
    (listener: () => void) => subscribePluginPointDiagnostics(listener),
    []
  )
  const getSnapshot = useCallback(() => readStableSnapshot(pluginId), [pluginId])
  const getServerSnapshot = useCallback(() => EMPTY_DIAGNOSTICS, [])
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

const EMPTY_DIAGNOSTICS: PluginPointDiagnostic[] = []

/**
 * Test-only — drop the snapshot cache between cases so leftover references
 * don't bleed across renderHook invocations.
 */
export function __resetUsePluginDiagnosticsCacheForTests(): void {
  cache.clear()
}
