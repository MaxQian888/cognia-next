"use client"

/**
 * Keeps this machine's live file-share host in step with the app
 * (ADR-0222 §7.5): confirms the unlocked account, pushes the effective
 * file-sharing policy whenever the person's own or the org's may have
 * changed, and pushes the granted conversations' mount tables. The host pulls
 * a table itself when it needs one fresh; this keeps it current between pulls,
 * and pushes a conversation's table the moment it is archived, restored or
 * deleted (`lib/filespace/lifecycle.ts`).
 *
 * Which account the host serves is not this component's call: the Rust
 * account session binds it on unlock and unbinds it on lock
 * (`AccountSecuritySession::bind_file_share`), and the host refuses an
 * activation for any other account. So while locked there is nothing to do.
 *
 * Desktop-only: it talks to this machine's host through Tauri IPC
 * (`localTransport`), even while a remote host is being driven. A headless
 * host runs the same controller in its brain
 * (`lib/headless/runtimes/file-share-host-sync.ts`).
 */

import { useEffect } from "react"

import {
  createFileShareHostSync,
  defaultLoadPolicy,
  type FileShareHostSync,
} from "@/lib/filespace/host-sync"
import { registerFileSpaceLifecycleSink } from "@/lib/filespace/lifecycle"
import { defaultMountTableDeps } from "@/lib/filespace/mount-table"
import { LOCAL_FILESPACE_HOST_ID } from "@/lib/filespace/resolve"
import { createLogger } from "@cognia/logging"
import { useAccountStore } from "@/stores/account/account-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

const log = createLogger("filespace.host-sync")

export function FileShareHostSyncInitializer() {
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  useEffect(() => {
    if (!unlockedAccountId) return
    const sync: FileShareHostSync = createFileShareHostSync({
      ...defaultMountTableDeps,
      target: { hostId: LOCAL_FILESPACE_HOST_ID },
      localAccountId: () => unlockedAccountId,
      loadPolicy: defaultLoadPolicy,
      log: (level, message) => log[level](message),
    })
    const stop = sync.start()
    // Archives, restores and deletes reach the host at once.
    const removeSink = registerFileSpaceLifecycleSink((ids) =>
      sync
        .sessionsChanged(ids)
        .catch((error) => log.warn(`lifecycle push failed: ${String(error)}`))
    )
    const unsubSettings = useSettingsStore.subscribe((state, prev) => {
      if (state.settings?.fileSharing !== prev.settings?.fileSharing) {
        void sync.pushPolicy().catch((error) => log.warn(`policy push failed: ${String(error)}`))
      }
    })
    const unsubProjects = useProjectStore.subscribe((state, prev) => {
      // A workspace root moved or appeared: the granted tables may differ.
      if (state.projects !== prev.projects) {
        void sync.refresh().catch((error) => log.warn(`refresh failed: ${String(error)}`))
      }
    })
    return () => {
      stop()
      removeSink()
      unsubSettings()
      unsubProjects()
    }
  }, [unlockedAccountId])

  return null
}

export default FileShareHostSyncInitializer
