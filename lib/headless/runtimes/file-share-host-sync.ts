/**
 * Headless registration of the live file-share host sync (ADR-0222 §7.5).
 *
 * On a headless host the brain is the app whose Dexie holds the
 * conversations, and its own server is the file-share host. The server
 * already serves the brain's one local account (it activates it at boot);
 * this runtime pushes the effective policy and the granted conversations'
 * mount tables, and keeps doing so on the same minute the host's maintenance
 * runs. The host pulls a mount table itself when it needs one fresh, through
 * the bridge request `installDesktopMessageSource` answers.
 */

import { createFileShareHostSync, defaultLoadPolicy } from "@/lib/filespace/host-sync"
import { defaultMountTableDeps } from "@/lib/filespace/mount-table"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "file-share-host-sync",
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
    return sync.start()
  },
})
