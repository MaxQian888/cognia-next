/**
 * Host filesystem seam for the LOCAL backup leg of the cron `backup`
 * executor (spec 2026-08-16, D). Mirrors the interval scheduler's
 * `BackupFilesystem` injection (`lib/data/backup-scheduler.ts`) so the same
 * executor writes to disk on the desktop (Tauri plugin-fs under
 * `appDataDir()/backups`) and on the headless brain (Node adapter installed
 * by the `backup-scheduler` headless runtime, directory =
 * `backupAutoSchedule.dirPath`).
 *
 * Hosts without a filesystem (browser, mobile webview) resolve to `null` and
 * the executor reports a clear error for the local leg.
 */

import { isTauri } from "@/lib/platform/detect"
import { getSettings } from "@/lib/db/settings"
import type { BackupFilesystem } from "./backup-scheduler"

export interface BackupHostFilesystem {
  filesystem: BackupFilesystem
  /** Directory the local leg writes into, or `null` when the host has none configured. */
  resolveBackupDir(): Promise<string | null>
  /** Join a directory and file name with the host's separator. */
  join(dir: string, name: string): string
  /** Where the adapter comes from — for diagnostics/tests. */
  kind: "tauri" | "injected"
}

let injected: BackupHostFilesystem | null = null

/**
 * Install a host filesystem (headless brain, tests). Pass `null` to remove.
 * Returns a disposer that removes it again.
 */
export function setBackupHostFilesystem(host: BackupHostFilesystem | null): () => void {
  injected = host
  return () => {
    if (injected === host) injected = null
  }
}

function joinPosixOrWindows(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/"
  return `${dir.replace(/[/\\]+$/, "")}${sep}${name}`
}

async function createTauriBackupHost(): Promise<BackupHostFilesystem> {
  const [{ appDataDir, join }, fs] = await Promise.all([
    import("@tauri-apps/api/path"),
    import("@tauri-apps/plugin-fs"),
  ])
  return {
    kind: "tauri",
    filesystem: {
      writeTextFile: (path, contents) => fs.writeTextFile(path, contents),
      readDirNames: async (path) => (await fs.readDir(path)).map((entry) => entry.name),
      remove: (path) => fs.remove(path),
    },
    async resolveBackupDir() {
      const root = await appDataDir()
      const dir = await join(root, "backups")
      try {
        await fs.mkdir(dir, { recursive: true })
      } catch {
        // Directory already exists or can't be created — `writeTextFile` will
        // surface a useful error if the path is genuinely unwritable.
      }
      return dir
    },
    join: joinPosixOrWindows,
  }
}

/**
 * Build the injected-host adapter used by the headless brain: the Node
 * filesystem from the runtime context, directory from `backupAutoSchedule`.
 */
export function createInjectedBackupHost(filesystem: BackupFilesystem): BackupHostFilesystem {
  return {
    kind: "injected",
    filesystem,
    async resolveBackupDir() {
      try {
        const settings = await getSettings()
        const dir = settings.backupAutoSchedule?.dirPath?.trim()
        return dir && dir.length > 0 ? dir : null
      } catch {
        return null
      }
    },
    join: joinPosixOrWindows,
  }
}

/** The host filesystem for this process, or `null` when there is none. */
export async function resolveBackupHostFilesystem(): Promise<BackupHostFilesystem | null> {
  if (injected) return injected
  if (isTauri()) return createTauriBackupHost()
  return null
}
