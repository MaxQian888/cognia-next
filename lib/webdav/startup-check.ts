// Decide whether the WebDAV server holds a snapshot newer than this device's
// most recent backup, so the app can offer a non-blocking "restore" prompt on
// startup. Dedupes via `webdavSync.lastRemoteSeenAt` so the same remote
// snapshot only prompts once.

import { getLatestSuccessful } from "@/lib/db/backup-history"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { makeWebDavClient } from "./config"

const LATEST_POINTER = "latest.enc.cbk"

export interface StartupCheckResult {
  newer: boolean
  /** Remote snapshot mtime (epoch ms), when one exists. */
  remoteAt?: number
}

/**
 * Returns `null` when WebDAV sync is disabled/unconfigured or unavailable on
 * this platform. Otherwise `{ newer }` — true only when the remote `latest`
 * pointer is newer than both the last local backup and the last upload, and we
 * haven't already prompted for this exact snapshot.
 */
export async function checkRemoteNewerThanLocal(): Promise<StartupCheckResult | null> {
  let made: Awaited<ReturnType<typeof makeWebDavClient>>
  try {
    made = await makeWebDavClient()
  } catch {
    // Transport unavailable (e.g. web) — silently skip.
    return null
  }
  if (!made) return null
  const { client, config } = made

  const remoteAt = await client.lastModified(`${config.remoteDir}/${LATEST_POINTER}`)
  if (remoteAt == null) return { newer: false }

  const settings = await getSettings()
  const wd = settings.webdavSync

  const lastSeen = wd?.lastRemoteSeenAt ? Date.parse(wd.lastRemoteSeenAt) : NaN
  if (!Number.isNaN(lastSeen) && remoteAt <= lastSeen) {
    return { newer: false, remoteAt }
  }

  const lastSyncAt = wd?.lastSyncAt ? Date.parse(wd.lastSyncAt) : NaN
  const latestLocal = await getLatestSuccessful()
  const localAt = Math.max(Number.isNaN(lastSyncAt) ? 0 : lastSyncAt, latestLocal?.completedAt ?? 0)

  const newer = remoteAt > localAt
  if (newer) {
    try {
      await saveSettings({
        webdavSync: { ...(wd ?? {}), lastRemoteSeenAt: new Date(remoteAt).toISOString() },
      })
    } catch {
      // Non-fatal — worst case we prompt again next launch.
    }
  }
  return { newer, remoteAt }
}
