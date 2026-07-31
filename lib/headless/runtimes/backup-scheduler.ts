/** Headless registration for the shared scheduled-backup runtime. */

import { startBackupScheduler, type ScheduledBackupMessages } from "@/lib/data/backup-scheduler"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "backup-scheduler",
  hosts: ["brain"],
  start: (ctx) => {
    if (!ctx.backupFilesystem) {
      throw new Error("backup-scheduler requires a host filesystem adapter")
    }
    const messages: ScheduledBackupMessages = {
      missingDestination: ctx.resolveMessage(
        "settings.data.webdav.startup.scheduledMissingDestination"
      ),
      autoKeyUnavailable: ctx.resolveMessage("settings.data.webdav.startup.autoKeyUnavailable"),
      syncPassphraseLocked: ctx.resolveMessage("settings.data.webdav.startup.syncPassphraseLocked"),
      newerTitle: ctx.resolveMessage("settings.data.webdav.startup.newerFound"),
      newerBody: ctx.resolveMessage("settings.data.webdav.startup.newerBody"),
    }
    return startBackupScheduler({
      filesystem: ctx.backupFilesystem,
      messages,
      log: (_level, message) => ctx.log("warn", `backup scheduler tick failed: ${message}`),
    })
  },
})
