// Plugin scheduled-task definition registry.
//
// Tracks the `manifest.scheduledTasks[]` definitions a plugin contributes, so
// the plugins UI can surface a count/diagnostics and the bridge has a fast
// per-plugin lookup. This is the DEFINITION metadata store — the actual
// firing `ScheduledTask` rows live in the scheduler's Dexie store, created by
// `lib/plugin/bridge/scheduled-task-bridge.ts`. The runtime HANDLER functions
// (keyed `${pluginId}:${handler}`) live in `scheduler-plugin-executor.ts`.
//
// In-memory only (font-registry pattern); cleared on plugin disable.

import type { PluginScheduledTaskDef } from "@/types/plugin/plugin"

export interface RegisteredScheduledTask {
  pluginId: string
  def: PluginScheduledTaskDef
}

/** Keyed by `${pluginId}:${name}`. */
const tasks = new Map<string, RegisteredScheduledTask>()
const listeners = new Set<() => void>()
let snapshot: RegisteredScheduledTask[] | null = null

function emit(): void {
  snapshot = null
  for (const fn of listeners) {
    try {
      fn()
    } catch (err) {
      console.warn("Scheduled-task registry listener threw:", err)
    }
  }
}

function key(pluginId: string, name: string): string {
  return `${pluginId}:${name}`
}

/** Register every scheduled-task definition a plugin contributes. Replaces the plugin's prior set. */
export function registerScheduledTaskDefsForPlugin(
  pluginId: string,
  defs: ReadonlyArray<PluginScheduledTaskDef>
): number {
  for (const k of [...tasks.keys()]) {
    if (tasks.get(k)?.pluginId === pluginId) tasks.delete(k)
  }
  let registered = 0
  for (const def of defs) {
    const name = def.name?.trim()
    if (!name) continue
    tasks.set(key(pluginId, name), { pluginId, def })
    registered += 1
  }
  emit()
  return registered
}

/** Remove every scheduled-task definition owned by `pluginId`. Returns the count removed. */
export function unregisterScheduledTaskDefsByPlugin(pluginId: string): number {
  let removed = 0
  for (const [k, value] of tasks) {
    if (value.pluginId === pluginId) {
      tasks.delete(k)
      removed += 1
    }
  }
  if (removed > 0) emit()
  return removed
}

/** Snapshot of every registered scheduled-task definition. Stable until next mutation. */
export function listScheduledTaskDefs(): RegisteredScheduledTask[] {
  if (!snapshot) snapshot = [...tasks.values()]
  return snapshot
}

export function subscribeScheduledTaskDefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Exposed for tests. */
export function __resetScheduledTaskRegistryForTesting(): void {
  tasks.clear()
  listeners.clear()
  snapshot = null
}
