"use client"

/**
 * Owns the ADR-0062 session-history live-sync watch for the app's lifetime,
 * mounted inside `DesktopOnlyInitializers` (main desktop window only).
 *
 * The watch used to be started from inside `SessionImportDialog`, so it died
 * — half-way — the moment the dialog closed: the Tauri listener was dropped
 * but `session_import_watch_stop` was never called, leaving the Rust watcher
 * installed with nobody listening, and the switch re-reading as "off". Nothing
 * persisted the choice either, so it never survived a restart.
 *
 * Here the persisted `AppSettings.sessionImportWatch.enabled` preference is the
 * single source of truth: flipping it in the dialog starts/stops the one
 * process-wide watch, and a restart restores it. Switching workspace re-targets
 * the running watch rather than restarting it, so newly imported sessions land
 * in the workspace that is active NOW.
 */

import { useEffect } from "react"

import {
  retargetSessionImportWatch,
  startSessionImportWatch,
  stopSessionImportWatch,
} from "@/lib/session-import/watch-controller"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

export function SessionImportWatchInitializer() {
  const enabled = useSettingsStore((s) => s.settings?.sessionImportWatch?.enabled ?? false)
  // `loaded` gates the first run: before the settings row is read the selector
  // yields `false`, and acting on that would fire a stop against a watcher that
  // was never started (and, worse, would look like the user turned it off).
  const loaded = useSettingsStore((s) => s.loaded)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)

  useEffect(() => {
    if (!loaded) return
    if (!enabled) {
      void stopSessionImportWatch()
      return
    }
    // Re-target first, and synchronously: a start queued behind an in-flight
    // one only re-points the record when its turn comes, so a workspace switch
    // would keep landing imports in the old workspace until then. A no-op when
    // nothing is running yet, which the start below then handles.
    retargetSessionImportWatch(activeProjectId ?? undefined)
    // A failed start rejects (it no longer poisons the controller's queue), and
    // the controller has already logged it — this only keeps the `void` call
    // from surfacing as an unhandled rejection.
    void startSessionImportWatch({ projectId: activeProjectId ?? undefined }).catch(() => undefined)
    // No cleanup that stops the watch on re-render: the effect re-runs whenever
    // the workspace changes, and tearing the OS watch down just to reinstall it
    // would drop every event in between. Unmount teardown is the effect below.
  }, [loaded, enabled, activeProjectId])

  // Unmount (window teardown) stops the native watcher too — the leak this
  // initializer exists to close.
  useEffect(() => {
    return () => {
      void stopSessionImportWatch()
    }
  }, [])

  return null
}

export default SessionImportWatchInitializer
