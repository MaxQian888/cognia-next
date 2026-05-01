"use client"

// Mounts at app startup and runs the scheduled-backup loop. Every 30 minutes
// (and once on mount) we check `appSettings.backupAutoSchedule`; if it's
// enabled and the interval has elapsed since the last success, we kick off a
// new auto-key-encrypted backup.

import { useEffect, useRef } from "react"
import { isTauri } from "@/lib/tauri"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { DEFAULT_BACKUP_AUTO_SCHEDULE } from "@/lib/claude/types"
import {
  buildBackupPackage,
  defaultExportFileName,
  serializePackage,
} from "@/lib/data/build-package"
import { encryptBackupPackage } from "@/lib/data/crypto"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { appendBackupHistory, getLatestSuccessful } from "@/lib/db/backup-history"
import { pruneScheduledBackups, shouldRunScheduledBackup } from "@/lib/data/scheduler"

const CHECK_INTERVAL_MS = 30 * 60 * 1000

export function BackupSchedulerProvider({ children }: { children: React.ReactNode }) {
  const ranOnceRef = useRef(false)

  useEffect(() => {
    // The provider becomes a no-op in test runs unless explicitly enabled —
    // we don't want every component test to drag the scheduler in.
    if (process.env.NODE_ENV === "test") return
    if (typeof window === "undefined") return

    const tick = async () => {
      try {
        await runOnce()
      } catch (err) {
        // Schedule failures bubble up via backupHistory; nothing else to do.
        console.warn("scheduled backup tick failed", err)
      }
    }

    if (!ranOnceRef.current) {
      ranOnceRef.current = true
      void tick()
    }
    const id = window.setInterval(() => {
      void tick()
    }, CHECK_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [])

  return <>{children}</>
}

/**
 * Single iteration of the scheduler. Exported for tests + manual triggers.
 * Returns true when a backup actually ran, false otherwise.
 */
export async function runOnce(): Promise<boolean> {
  const settings = await getSettings()
  const config = settings.backupAutoSchedule
  if (!config?.enabled) return false

  const lastSuccessful = await getLatestSuccessful()
  const lastFromSchedule = lastSuccessful?.type === "scheduled" ? lastSuccessful : undefined
  if (
    !shouldRunScheduledBackup({
      config,
      lastSuccessAt: lastFromSchedule?.completedAt,
    })
  ) {
    return false
  }
  if (!isTauri() || !config.dirPath) {
    // Without a destination folder we don't have anywhere to write silently.
    // Web users get reminders; Tauri without a configured folder is also a no-op.
    await appendBackupHistory({
      completedAt: Date.now(),
      type: "scheduled",
      success: false,
      encryption: "auto-key",
      errorMessage: "Schedule enabled but no destination folder configured.",
    })
    return false
  }

  try {
    const pkg = await buildBackupPackage({ includeSessions: true, includeApiKey: false })
    const plaintext = serializePackage(pkg)
    const passphrase = await getDefaultBackupPassphrase()
    if (!passphrase) {
      throw new Error("Auto-key not available on this runtime.")
    }
    const env = await encryptBackupPackage(plaintext, passphrase, {
      version: pkg.manifest.version,
      schemaVersion: pkg.manifest.schemaVersion,
      traceId: pkg.manifest.traceId,
      exportedAt: pkg.manifest.exportedAt,
      appVersion: pkg.manifest.appVersion,
      backend: pkg.manifest.backend,
      encryption: { enabled: true, format: "encrypted-envelope-v1" },
    })
    const body = JSON.stringify(env)
    const fileName = defaultExportFileName(new Date(), "encrypted")
    const sep = config.dirPath.includes("\\") ? "\\" : "/"
    const target = `${config.dirPath.replace(/[/\\]+$/, "")}${sep}${fileName}`

    const { writeTextFile, readDir, remove } = await import("@tauri-apps/plugin-fs")
    await writeTextFile(target, body)

    // Prune older auto-backups so the directory doesn't grow unbounded.
    try {
      const entries = await readDir(config.dirPath)
      const candidates = entries
        .filter((e) => e.name && e.name.endsWith(".enc.cbk"))
        .map((e) => ({
          name: `${config.dirPath}${sep}${e.name}`,
          completedAt: 0,
        }))
      // We can't read mtime here without a stat call; approximate by lex order
      // of the date-stamped filename — defaultExportFileName is `cognia-backup-YYYY-MM-DD.enc.cbk`.
      const sorted = candidates.sort((a, b) => (a.name < b.name ? 1 : -1))
      const toRemove = pruneScheduledBackups(
        sorted.map((c, i) => ({ ...c, completedAt: -i })),
        config.retainCount
      )
      for (const c of toRemove) {
        try {
          await remove(c.name)
        } catch {
          // Best-effort.
        }
      }
    } catch {
      // readDir/permissions failure — non-fatal.
    }

    await appendBackupHistory({
      completedAt: Date.now(),
      type: "scheduled",
      success: true,
      encryption: "auto-key",
      sizeBytes: body.length,
      filename: fileName,
    })
    // Stamp lastRunAt for cross-device sync + UI "next run at".
    try {
      await saveSettings({
        backupAutoSchedule: {
          ...(config ?? DEFAULT_BACKUP_AUTO_SCHEDULE),
          lastRunAt: new Date().toISOString(),
        },
      })
    } catch {
      // Non-fatal.
    }
    return true
  } catch (err) {
    await appendBackupHistory({
      completedAt: Date.now(),
      type: "scheduled",
      success: false,
      encryption: "auto-key",
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
