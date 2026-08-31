"use client"

import { useEffect } from "react"

import {
  SELECTION_TOOLBAR_DISABLED_APPS_PREF,
  SELECTION_TOOLBAR_DISABLED_SITES_PREF,
  SELECTION_TOOLBAR_ENABLED_PREF,
  SELECTION_TOOLBAR_MODE_PREF,
  startSelectionToolbar,
} from "@/lib/tauri/selection-toolbar"
import { getPref, setPref } from "@/lib/tauri/store"
import { migrateSelectionToolbarMode, type SelectionToolbarMode } from "@/lib/selection/preferences"
import { ensureBootCapability } from "@/lib/boot/capabilities"

/**
 * Restore the native monitor above AccountGate so an opted-in toolbar keeps
 * working while Cognia is locked or hidden in the tray.
 */
export function SelectionToolbarRestoreInitializer() {
  useEffect(() => {
    void Promise.all([
      getPref<SelectionToolbarMode>(SELECTION_TOOLBAR_MODE_PREF),
      getPref<boolean>(SELECTION_TOOLBAR_ENABLED_PREF),
      getPref<string[]>(SELECTION_TOOLBAR_DISABLED_APPS_PREF),
      getPref<string[]>(SELECTION_TOOLBAR_DISABLED_SITES_PREF),
    ]).then(([savedMode, legacyEnabled, disabledApps, disabledSites]) => {
      const mode = migrateSelectionToolbarMode(savedMode ?? undefined, legacyEnabled ?? undefined)
      if (mode === "off") return
      void setPref(SELECTION_TOOLBAR_MODE_PREF, mode)
      void ensureBootCapability("desktop-tools")
        .then(() =>
          startSelectionToolbar({
            mode,
            disabledApps: disabledApps ?? [],
            disabledSites: disabledSites ?? [],
          })
        )
        .catch(() => {
          // Permission may have been revoked between launches. Fail closed and
          // require a fresh explicit opt-in from Desktop settings.
          void setPref(SELECTION_TOOLBAR_MODE_PREF, "off")
          void setPref(SELECTION_TOOLBAR_ENABLED_PREF, false)
        })
    })
  }, [])
  return null
}

export default SelectionToolbarRestoreInitializer
