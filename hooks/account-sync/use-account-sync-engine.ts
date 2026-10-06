"use client"

/**
 * Runs account sync's data engine in this window (ADR-0215 phase 3a) while
 * the build flag is on, the poller sees this device enrolled, and the active
 * database is the profile's own (never a companion mirror of another host).
 * The engine itself elects one window per database to do the work.
 *
 * Remote changes to settings are read back into the settings store; every
 * other synced table is read through live queries and refreshes itself.
 *
 * Off means off: with `enabled` false nothing is resolved, armed or contacted
 * (`use-account-sync-engine.test.ts`).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"

import { startAccountSyncEngine, type AccountSyncEngineDeps } from "@/lib/account-sync/data/engine"
import { publishRemoteChanges } from "@/lib/account-sync/data/remote-changes"
import {
  ownAccountDatabase,
  subscribeDatabaseAuthority,
} from "@/lib/account-sync/data/own-database"
import type { CogniaDB } from "@/lib/db/schema"
import { getSettings } from "@/lib/db/settings"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

export interface UseAccountSyncEngineOptions {
  enabled: boolean
  /** Test seams. */
  start?: typeof startAccountSyncEngine
  ownDatabase?: (localAccountId: string) => CogniaDB | null
  subscribeAuthority?: (listener: () => void) => () => void
  reloadSettings?: () => Promise<void>
  locks?: AccountSyncEngineDeps["locks"]
  openSocket?: AccountSyncEngineDeps["openSocket"]
}

/** Reads the settings row back after another device changed a shared key. */
export async function reloadSettingsFromDatabase(): Promise<void> {
  const settings = await getSettings()
  useSettingsStore.setState({ settings })
}

export function useAccountSyncEngine(options: UseAccountSyncEngineOptions): void {
  const { enabled } = options
  const context = useAccountSyncStore((state) => state.context)
  const view = useAccountSyncStore((state) => state.view)
  const device = view.kind === "enrolled" ? view.device : null
  const deviceId = device?.deviceId ?? null
  const deviceRef = useRef(device)
  const seams = useRef(options)
  useEffect(() => {
    deviceRef.current = device
    seams.current = options
  })
  const [generation, setGeneration] = useState(0)

  // Which database is this profile's own right now (it changes with the target).
  const { ownDatabase, subscribeAuthority } = options
  const subscribe = useCallback(
    (listener: () => void) => (subscribeAuthority ?? subscribeDatabaseAuthority)(listener),
    [subscribeAuthority]
  )
  const databaseName = useSyncExternalStore(
    subscribe,
    () =>
      enabled && context
        ? ((ownDatabase ?? ownAccountDatabase)(context.session.localAccountId)?.name ?? null)
        : null,
    () => null
  )

  useEffect(() => {
    const keys = deviceRef.current
    if (!enabled || !context || !keys || keys.deviceId !== deviceId || !databaseName) return
    const own = seams.current.ownDatabase ?? ownAccountDatabase
    const db = own(context.session.localAccountId)
    if (!db || db.name !== databaseName) return
    const start = seams.current.start ?? startAccountSyncEngine
    const reload = seams.current.reloadSettings ?? reloadSettingsFromDatabase
    const store = () => useAccountSyncStore.getState()
    const engine = start({
      context,
      device: keys,
      db,
      ...(seams.current.locks !== undefined ? { locks: seams.current.locks } : {}),
      ...(seams.current.openSocket !== undefined ? { openSocket: seams.current.openSocket } : {}),
      onStatus: (status) => {
        store().setEngineStatus(status)
        // A removal also changes what the enrollment view shows.
        if (status.kind === "removed") store().requestRefresh()
        // The database was closed and reopened under us (an upgrade): start over on the new one.
        if (status.kind === "running" && status.error && own(context.session.localAccountId) !== db)
          setGeneration((value) => value + 1)
      },
      onApplied: (tables) => {
        if (tables.has("settings")) void reload().catch(() => undefined)
        // The open chat and other store-held views refresh from what landed.
        publishRemoteChanges(tables)
      },
      onRegistryChanged: () => store().requestRefresh(),
    })
    store().setEngine(engine)
    return () => {
      engine.stop()
      if (store().engine === engine) store().setEngine(null)
    }
  }, [enabled, context, deviceId, databaseName, generation])
}
