// Module-level bridge from the plugin `ctx` (available only in activate()) to
// the React panel (which receives only `{pluginId, viewId}` props). `activate`
// stashes the APIs here; the panel + runner read them via `getStrixRuntime()`.
// Mirrors pet-daily-quests' `configureQuestStore` decoupling.

import type { PluginDexieAPI } from "@/lib/plugin/api/dexie-api"
import type { PluginTerminalAPI } from "@/lib/plugin/api/terminal-api"

export interface StrixRuntime {
  terminal: PluginTerminalAPI
  dexie: PluginDexieAPI
}

let runtime: StrixRuntime | null = null

export function setStrixRuntime(rt: StrixRuntime): void {
  runtime = rt
}

export function clearStrixRuntime(): void {
  runtime = null
}

/** Runtime if wired, else null (panel renders a disabled state). */
export function peekStrixRuntime(): StrixRuntime | null {
  return runtime
}

/** Runtime or throw — for call sites that require it (the runner). */
export function getStrixRuntime(): StrixRuntime {
  if (!runtime) {
    throw new Error("strix-security: runtime not initialized (plugin not activated)")
  }
  return runtime
}
