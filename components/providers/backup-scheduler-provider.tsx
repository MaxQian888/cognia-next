"use client"

/** React host for the shared scheduled-backup runtime (ADR-0059 T-A6). */

import { useEffect } from "react"
import { useTranslations } from "next-intl"

import { isTauri } from "@/lib/tauri"
import {
  maybeUploadToWebDav as maybeUploadShared,
  runScheduledBackupOnce,
  startBackupScheduler,
  type BackupFilesystem,
  type ScheduledBackupMessages,
} from "@/lib/data/backup-scheduler"
import { loadMessageResolver } from "@/lib/headless/i18n"
import type { BackupPackageV3 } from "@/lib/data/types"

let activeMessages: ScheduledBackupMessages | null = null

function tauriBackupFilesystem(): BackupFilesystem | null {
  if (!isTauri()) return null
  return {
    async writeTextFile(path, contents) {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs")
      await writeTextFile(path, contents)
    },
    async readDirNames(path) {
      const { readDir } = await import("@tauri-apps/plugin-fs")
      const entries = await readDir(path)
      return entries.flatMap((entry) => (entry.name ? [entry.name] : []))
    },
    async remove(path) {
      const { remove } = await import("@tauri-apps/plugin-fs")
      await remove(path)
    },
  }
}

async function fallbackMessages(): Promise<ScheduledBackupMessages> {
  const resolve = await loadMessageResolver("en")
  return {
    missingDestination: resolve("settings.data.webdav.startup.scheduledMissingDestination"),
    autoKeyUnavailable: resolve("settings.data.webdav.startup.autoKeyUnavailable"),
    syncPassphraseLocked: resolve("settings.data.webdav.startup.syncPassphraseLocked"),
    newerTitle: resolve("settings.data.webdav.startup.newerFound"),
    newerBody: resolve("settings.data.webdav.startup.newerBody"),
  }
}

export function BackupSchedulerProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("settings.data.webdav.startup")

  useEffect(() => {
    if (process.env.NODE_ENV === "test" || typeof window === "undefined") return

    const messages: ScheduledBackupMessages = {
      missingDestination: t("scheduledMissingDestination"),
      autoKeyUnavailable: t("autoKeyUnavailable"),
      syncPassphraseLocked: t("syncPassphraseLocked"),
      newerTitle: t("newerFound"),
      newerBody: t("newerBody"),
    }
    activeMessages = messages
    const stop = startBackupScheduler({
      filesystem: tauriBackupFilesystem(),
      messages,
      log: (_level, message) => console.warn("scheduled backup tick failed", message),
    })
    return () => {
      stop()
      if (activeMessages === messages) activeMessages = null
    }
  }, [t])

  return <>{children}</>
}

/** Manual/scheduler-source entry preserved for existing callers. */
export async function runOnce(): Promise<boolean> {
  return runScheduledBackupOnce({
    filesystem: tauriBackupFilesystem(),
    messages: activeMessages ?? (await fallbackMessages()),
  })
}

/** Compatibility export used by existing focused tests and callers. */
export async function maybeUploadToWebDav(
  enabled: boolean,
  pkg: BackupPackageV3,
  plaintext: string
): Promise<void> {
  const messages = activeMessages ?? (await fallbackMessages())
  return maybeUploadShared(enabled, pkg, plaintext, messages)
}
