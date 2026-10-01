/**
 * "A plugin's enable intent changed" — one signal for every surface.
 *
 * `PluginManager.setPluginIntent` is the single path every toggle takes (the
 * panel, the batch bar, mobile via the host queue, cogset activation), so it is
 * the one place that can tell a listener what changed and why. Emitted only
 * after the transition completed; a toggle that threw emits nothing, because
 * the plugin did not end up where the caller asked.
 *
 * The `reason` is the caller's own string (`"manual"`, `"batch"`, `"cogset"`,
 * …). Listeners that react to user changes filter out the reasons they caused
 * themselves; the cogset write-through ignores `"cogset"` for that reason.
 */

import { loggers } from "@cognia/logging"

import type { PluginIntent } from "./lifecycle-state"

export interface PluginIntentChange {
  pluginId: string
  intent: PluginIntent
  reason: string
}

type Listener = (change: PluginIntentChange) => void

const listeners = new Set<Listener>()

export function subscribePluginIntentChanges(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitPluginIntentChange(change: PluginIntentChange): void {
  for (const listener of listeners) {
    try {
      listener(change)
    } catch (error) {
      loggers.plugin.warn(`[plugin:${change.pluginId}] intent listener threw (ignored)`, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** Test-only. */
export function __resetPluginIntentListenersForTesting(): void {
  listeners.clear()
}
