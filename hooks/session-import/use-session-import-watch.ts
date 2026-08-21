"use client"

// Live-sync toggle for external-agent session import (ADR-0062, T5).
//
// This hook is now only the SWITCH: it reads and writes the persisted
// `AppSettings.sessionImportWatch.enabled` preference. The watch itself is
// owned for the app's lifetime by `lib/session-import/watch-controller.ts`,
// driven from that preference by `SessionImportWatchInitializer`.
//
// It used to own the watcher directly, from inside `SessionImportDialog`. That
// made the switch dishonest: closing the dialog dropped the event listener but
// never stopped the Rust watcher, the switch always re-read as "off", and the
// choice never survived a restart — while the copy promises "Keep watching
// these agents and import new sessions automatically".

import { useCallback } from "react"
import type { AppSettings } from "@cognia/agent-config-types"
import { useSettingsStore } from "@/stores/settings/settings-store"

export interface UseSessionImportWatchDeps {
  saveSettings?: (patch: Partial<Omit<AppSettings, "id">>) => Promise<unknown>
}

export function useSessionImportWatch(opts: { deps?: UseSessionImportWatchDeps } = {}): {
  enabled: boolean
  toggle: (on: boolean) => Promise<void>
} {
  const storeSave = useSettingsStore((s) => s.save)
  const save = opts.deps?.saveSettings ?? storeSave
  // Selected as a primitive, not as the `sessionImportWatch` object: the
  // settings row is replaced wholesale on every save, so selecting the object
  // would re-render every consumer on any unrelated settings write.
  const enabled = useSettingsStore((s) => s.settings?.sessionImportWatch?.enabled ?? false)

  const toggle = useCallback(
    async (on: boolean) => {
      await save({ sessionImportWatch: { enabled: on } })
    },
    [save]
  )

  return { enabled, toggle }
}
