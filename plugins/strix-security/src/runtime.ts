// Module-level bridge from the plugin `ctx` (available only in activate()) to
// the React panel (which receives only `ContextPanelRenderProps`). `activate`
// stashes the APIs here; the panel + runner read them via `getStrixRuntime()`.
// Mirrors pet-daily-quests' `configureQuestStore` decoupling.

import type { PluginContextPanelAPI } from "@cognia/plugin-sdk"
import type { PluginDexieAPI } from "@cognia/plugin-sdk"
import type { PluginSecurityScansAPI, PluginTerminalAPI } from "@cognia/plugin-sdk"
export interface StrixRuntime {
  terminal: PluginTerminalAPI
  dexie: PluginDexieAPI
  securityScans: PluginSecurityScansAPI
  /**
   * The workbench API the panel was registered through, so a running scan can
   * put a count on its own rail button. Null when registration was refused —
   * the panel still works, it just cannot announce itself from off-screen.
   */
  contextPanels?: PluginContextPanelAPI | null
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
