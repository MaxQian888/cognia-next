/**
 * The one writer of `AppSettings.routerFusion` (ADR-0188).
 *
 * Reads what is persisted, normalizes it (so a partial or older shape becomes a
 * complete, valid object), applies the patch and saves through the settings
 * store. Every writer — the settings section, the breaker's trip persistence —
 * goes through here, so nothing ever persists half an object.
 *
 * Not on any send path: the settings UI imports it, and the boot initializer
 * loads it dynamically only when a breaker event has to be written.
 */

import {
  normalizeRouterFusionSettings,
  type RouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"
import { useSettingsStore } from "@/stores/settings"

export function currentRouterFusionSettings(): RouterFusionSettings {
  return normalizeRouterFusionSettings(useSettingsStore.getState().settings?.routerFusion)
}

export async function saveRouterFusionSettings(
  patch:
    | Partial<RouterFusionSettings>
    | ((current: RouterFusionSettings) => Partial<RouterFusionSettings>)
): Promise<RouterFusionSettings> {
  const current = currentRouterFusionSettings()
  const changes = typeof patch === "function" ? patch(current) : patch
  const next = normalizeRouterFusionSettings({ ...current, ...changes })
  await useSettingsStore.getState().save({ routerFusion: next })
  return next
}
