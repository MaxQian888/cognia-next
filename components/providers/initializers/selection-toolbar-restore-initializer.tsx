"use client"

import { useEffect } from "react"

import {
  SELECTION_TOOLBAR_DISABLED_APPS_PREF,
  SELECTION_TOOLBAR_ENABLED_PREF,
  startSelectionToolbar,
} from "@/lib/tauri/selection-toolbar"
import { getPref, setPref } from "@/lib/tauri/store"

/**
 * Restore the native monitor above AccountGate so an opted-in toolbar keeps
 * working while Cognia is locked or hidden in the tray.
 */
export function SelectionToolbarRestoreInitializer() {
  useEffect(() => {
    void Promise.all([
      getPref<boolean>(SELECTION_TOOLBAR_ENABLED_PREF),
      getPref<string[]>(SELECTION_TOOLBAR_DISABLED_APPS_PREF),
    ]).then(([enabled, disabledApps]) => {
      if (!enabled) return
      void startSelectionToolbar(disabledApps ?? []).catch(() => {
        // Permission may have been revoked between launches. Fail closed and
        // require a fresh explicit opt-in from Desktop settings.
        void setPref(SELECTION_TOOLBAR_ENABLED_PREF, false)
      })
    })
  }, [])
  return null
}

export default SelectionToolbarRestoreInitializer
