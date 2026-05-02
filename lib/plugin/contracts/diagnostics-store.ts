/**
 * Central aggregator for plugin-point diagnostics across UI slot, hook, and
 * activation sources. Consumed by the plugin diagnostics panel to render a
 * unified view per plugin.
 */

import type { PluginPointDiagnostic } from "./plugin-points"

const diagnosticsByPlugin = new Map<string, PluginPointDiagnostic[]>()
const listeners = new Set<() => void>()
let revision = 0

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
  diagnosticsByPlugin.set(pluginId, existing)
  notify()
}

export function getPluginPointDiagnostics(pluginId: string): PluginPointDiagnostic[] {
  return [...(diagnosticsByPlugin.get(pluginId) || [])]
}

export function getAllPluginPointDiagnostics(): Record<string, PluginPointDiagnostic[]> {
  const out: Record<string, PluginPointDiagnostic[]> = {}
  for (const [pluginId, diagnostics] of diagnosticsByPlugin.entries()) {
    out[pluginId] = [...diagnostics]
  }
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
