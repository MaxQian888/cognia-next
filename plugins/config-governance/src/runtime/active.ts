/**
 * The runtime of the current activation, for surfaces that receive no
 * context: the view (`PluginViewProps` carries only ids) and module-level
 * exports. Set in `activate`, cleared on dispose, and observable so a view
 * mounted before activation finishes renders once it does.
 */
import type { GovernanceRuntime } from "./runtime"

let active: GovernanceRuntime | null = null
const listeners = new Set<() => void>()

export function setActiveRuntime(runtime: GovernanceRuntime | null): void {
  active = runtime
  for (const listener of listeners) listener()
}

export function getActiveRuntime(): GovernanceRuntime | null {
  return active
}

export function subscribeActiveRuntime(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
