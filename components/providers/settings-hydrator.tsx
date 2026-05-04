"use client"

import { useEffect } from "react"
import { useSettingsStore } from "@/stores/settings"

/**
 * Mounts at the root layout and triggers `useSettingsStore.load()` exactly
 * once. Without this hook the store stays at `{ loaded: false, settings: null }`
 * forever, which makes `SettingsSyncProvider` early-return and the user sees
 * defaults regardless of what's persisted in Dexie.
 *
 * `load()` itself is idempotent (early-returns when `loaded`), so re-mounts
 * during dev/HMR don't trigger duplicate Dexie reads.
 */
export function SettingsHydrator(): null {
  useEffect(() => {
    void useSettingsStore.getState().load()
  }, [])
  return null
}
