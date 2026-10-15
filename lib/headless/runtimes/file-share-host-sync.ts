/**
 * Headless registration of the live file-share host sync (ADR-0222 §7.5).
 *
 * On a headless host the brain is the app whose Dexie holds the
 * conversations, and its own server is the file-share host. The server
 * already serves the brain's one local account (it activates it at boot);
 * this runtime pushes the effective policy and the granted conversations'
 * mount tables, and keeps doing so on the same minute the host's maintenance
 * runs. The host pulls a mount table itself when it needs one fresh, through
 * the bridge request `installDesktopMessageSource` answers. An archive, restore
 * or delete is pushed at once (`lib/filespace/lifecycle.ts`).
 */

import { createFileShareHostSync, defaultLoadPolicy } from "@/lib/filespace/host-sync"
import { registerFileSpaceLifecycleSink } from "@/lib/filespace/lifecycle"
import { defaultMountTableDeps } from "@/lib/filespace/mount-table"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "file-share-host-sync",
  criticality: "optional",
  hosts: ["brain"],
  start: (ctx) => {
    const sync = createFileShareHostSync({
      ...defaultMountTableDeps,
      // The brain's transport is its own server's service plane.
      target: {},
      accountId: () => ctx.localAccountId,
      loadPolicy: defaultLoadPolicy,
      log: (level, message) => ctx.log(level, message),
    })
    const stop = sync.start()
    // Archives, restores and deletes reach the host at once.
    const removeSink = registerFileSpaceLifecycleSink((ids) =>
      sync
        .sessionsChanged(ids)
        .catch((error) => ctx.log("warn", `file share: lifecycle push failed: ${String(error)}`))
    )
    return () => {
      stop()
      removeSink()
    }
  },
})
