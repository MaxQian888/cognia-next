/**
 * Bridge between `activate()` and the Context Workbench panel.
 *
 * A panel component receives only `{ workbenchInstanceId, resource, active }`
 * — the host owns its mount — so anything the panel needs from the plugin
 * context has to be parked somewhere both can reach. Module-level, exactly like
 * `plugins/strix-security/src/runtime.ts`, and cleared on deactivate so a
 * disabled plugin's panel cannot keep querying.
 *
 * The activity bus is the second half. The SRE subagent queries evidence
 * through the same four tools, and without a signal the panel could only ever
 * show what the *panel* fetched — the agent's work would be invisible next to
 * it. `tools.ts` publishes each successful query here; the panel subscribes.
 * This is observation, not control: the plugin does not hold `agent:dispatch`,
 * so it can watch a run it did not start and must not pretend it can steer one.
 */

import type { PluginDexieAPI } from "@/lib/plugin/api/dexie-api"
import type { PluginContextPanelAPI } from "@/lib/plugin/api/context-panel-api"
import type { SreRuntime } from "./runtime"

export interface SrePanelRuntime {
  runtime: SreRuntime
  /** Null when the shell gave the plugin no Dexie — the panel degrades, loudly. */
  dexie: PluginDexieAPI | null
  /**
   * The workbench API the panel was registered through, so the panel can push
   * an open-incident count onto its own rail button. Null in a shell that
   * refused the registration.
   */
  contextPanels: PluginContextPanelAPI | null
}

export interface SreToolActivity {
  tool: string
  evidenceIds: string[]
  at: string
}

/** How many recent queries the panel can offer to pin. Older ones fall off. */
const ACTIVITY_LIMIT = 50

let current: SrePanelRuntime | null = null
let activity: SreToolActivity[] = []
const listeners = new Set<(latest: readonly SreToolActivity[]) => void>()

export function setSrePanelRuntime(next: SrePanelRuntime): void {
  current = next
}

export function clearSrePanelRuntime(): void {
  current = null
  activity = []
  listeners.clear()
}

export function peekSrePanelRuntime(): SrePanelRuntime | null {
  return current
}

/** Record one successful evidence query. No-ops once the plugin is deactivated. */
export function notifySreToolActivity(event: SreToolActivity): void {
  if (!current) return
  activity = [...activity, event].slice(-ACTIVITY_LIMIT)
  for (const listener of listeners) listener(activity)
}

export function subscribeSreToolActivity(
  listener: (latest: readonly SreToolActivity[]) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function recentSreToolActivity(): readonly SreToolActivity[] {
  return activity
}
