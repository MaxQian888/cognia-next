/**
 * The settings a Router + Fusion gate check reads, on whichever host this is
 * (ADR-0188 D36, B2).
 *
 * The desktop window keeps `useSettingsStore` loaded — `SettingsHydrator`
 * mounts at the root layout and loads it once. A headless brain never mounts
 * that provider, so its store stays empty, and a gate reading the store there
 * would find every switch "off" even after the account turned one on. That
 * matters since B2: the brain answers the gateway's Run API and passthrough
 * commands when it is the connected brain, and it runs workflows whose
 * `ai.prompt` nodes are gated too.
 *
 * So the store wins when it is loaded (it is the live copy, including edits a
 * save has not flushed), and otherwise the account's settings row is read from
 * Dexie — the same row the store would have loaded. A read that fails answers
 * `null`, which the gate reads as off: an unreadable switch never turns
 * Router + Fusion on.
 *
 * Both dependencies are imported lazily so this module stays as light as the
 * rest of the gate.
 */

import type { AppSettings } from "@cognia/agent-config-types"

export async function currentRouterFusionGateSettings(): Promise<AppSettings | null> {
  const { useSettingsStore } = await import("@/stores/settings/settings-store")
  const state = useSettingsStore.getState()
  if (state.loaded) return state.settings ?? null
  try {
    const { getSettings } = await import("@/lib/db/settings")
    return await getSettings()
  } catch (error) {
    console.warn("[router-fusion] settings unreadable; treating every surface as off", error)
    return null
  }
}
