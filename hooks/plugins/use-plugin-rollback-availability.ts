"use client"

/**
 * Whether "Roll back" can do anything for this plugin on this host.
 *
 * The row menu offered Rollback on every plugin, on every host. Off the
 * desktop the dialog could only say "desktop only"; on the desktop, a plugin
 * that had never been updated had no backup to go back to, so the dialog
 * opened on an empty list. The item is now shown only when the desktop shell
 * is present AND the backup index holds a snapshot of a version other than the
 * one installed — the same condition `PluginRollbackManager` uses to mark a
 * backup `canRollback`.
 *
 * The backup manager keeps its index in memory and loads it from storage in
 * `initialize()`. Nothing on the app's boot path calls that, so without the
 * one-shot load below the index would only ever contain backups taken in the
 * current session. The load is idempotent (it re-reads the persisted index,
 * which every backup write keeps current) and runs once per page.
 */

import { useSyncExternalStore } from "react"

import { getPluginBackupManager } from "@/lib/plugin/lifecycle/backup"
import { isTauri } from "@/lib/tauri"

let indexLoad: Promise<void> | null = null
let indexRevision = 0
const listeners = new Set<() => void>()

function notify(): void {
  indexRevision += 1
  for (const listener of listeners) listener()
}

/** Load the persisted backup index once; resolves when the index is readable. */
export function ensurePluginBackupIndexLoaded(): Promise<void> {
  if (!indexLoad) {
    indexLoad = getPluginBackupManager()
      .initialize()
      .catch(() => undefined)
      .then(notify)
  }
  return indexLoad
}

/** Call after creating / deleting / restoring a backup so readers re-check. */
export function notifyPluginBackupsChanged(): void {
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Off the desktop shell the answer is always "no", so there is nothing to
  // load (and no backup manager work to start in a browser or on a phone).
  if (isTauri()) void ensurePluginBackupIndexLoaded()
  return () => {
    listeners.delete(listener)
  }
}

const getRevision = () => indexRevision
const getServerRevision = () => 0

/** Test-only: forget the one-shot load so each suite starts cold. */
export function __resetPluginBackupIndexForTests(): void {
  indexLoad = null
  indexRevision = 0
  listeners.clear()
}

/**
 * Revision of the backup index: changes when the persisted index finishes
 * loading and whenever `notifyPluginBackupsChanged` is called. Readers of
 * `getPluginBackupManager().getBackups()` key their derivations on it.
 */
export function usePluginBackupIndexRevision(): number {
  return useSyncExternalStore(subscribe, getRevision, getServerRevision)
}

export function usePluginRollbackAvailable(pluginId: string, currentVersion: string): boolean {
  // Re-render when the index loads or a backup is written.
  usePluginBackupIndexRevision()
  if (!isTauri()) return false
  return getPluginBackupManager()
    .getBackups(pluginId)
    .some((backup) => backup.version !== currentVersion)
}
