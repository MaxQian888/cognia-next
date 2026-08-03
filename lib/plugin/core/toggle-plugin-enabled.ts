/**
 * The single enable/disable path for the `/plugins` panel.
 *
 * # The gap this closes
 *
 * Every toggle in the panel — library row, card grid, detail header, batch bar
 * — used to call `setPluginEnabled` from `lib/db/plugins`, which writes the
 * Dexie `enabled` column and stops. Nothing subscribed to that column to drive
 * the manager, so flipping the switch never ran `activate()`, never registered
 * contributions, and never fired `onEnable`. The plugin's row said "enabled"
 * while its runtime had never started.
 *
 * That also silently disabled the existing loading UI: no code path ever wrote
 * `enabling` / `loading` to the Dexie row, so `PluginStatusPill`'s loading
 * branch and the `isLoading` derivation duplicated across three components
 * were unreachable from the panel.
 *
 * So the Dexie write is now a *consequence* of the manager transition rather
 * than a substitute for it — which is also what makes the seven-phase
 * activation progress observable from the surface the user actually clicks.
 */

import { setPluginEnabled } from "@/lib/db/plugins"
import { loggers } from "@cognia/logging"

import { getPluginManager } from "./manager"

export interface TogglePluginResult {
  ok: boolean
  /** Present when the transition failed; already human-readable. */
  error?: string
}

/**
 * Enable or disable a plugin through the manager.
 *
 * On failure the Dexie flag is restored to its previous value, so an optimistic
 * switch snaps back instead of lying about a runtime that never started. The
 * manager's own rollback (contributions unregistered, status set to `error`,
 * `PLUGIN_ENABLE_FAILED_EVENT` dispatched) has already run by then — this only
 * reconciles the flag the panel renders from.
 */
export async function togglePluginEnabled(
  pluginId: string,
  next: boolean,
  reason = "manual"
): Promise<TogglePluginResult> {
  const manager = getPluginManager()
  // Write first so the switch responds immediately; a 10–45 s activation with
  // an unmoved switch reads as a dead click.
  await setPluginEnabled(pluginId, next)

  try {
    if (next) {
      await manager.enablePlugin(pluginId, reason)
    } else {
      await manager.disablePlugin(pluginId, reason)
    }
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    loggers.plugin.warn(`[plugin:${pluginId}] toggle to ${next} failed`, { error: message })
    try {
      await setPluginEnabled(pluginId, !next)
    } catch {
      // The revert is best-effort: the manager already recorded the real
      // failure, and a Dexie write failing here would only mask it.
    }
    return { ok: false, error: message }
  }
}
