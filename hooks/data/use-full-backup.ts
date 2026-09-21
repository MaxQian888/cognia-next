"use client"

// Encapsulates the full export flow: stream the v4 backup, optionally encrypt,
// open the save dialog (Tauri) or trigger a download (web), then record the
// outcome in `backupHistory`. Errors are returned to the caller as an
// { ok: false, error } shape so the UI can render inline messages instead of
// shouting to a toast for every failure path.

import { useCallback, useState } from "react"
import { isTauri } from "@/lib/tauri"
import { defaultExportFileName } from "@/lib/data/build-package"
import { buildBackupStream } from "@/lib/data/build-stream"
import { backupStreamBlob, writeBackupStreamFile } from "@/lib/files/file-bridge"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { appendBackupHistory } from "@/lib/db/backup-history"
import type { BackupHistoryType } from "@/lib/db/backup-history"
import type { ExportOptions } from "@/lib/data/types"
import type { EncryptionMode } from "@/components/data/shared/encryption-options"

export interface RunBackupArgs extends ExportOptions {
  encryption: EncryptionMode
  passphrase?: string
  type?: BackupHistoryType
  /** Pre-resolved destination path (for scheduled backups). */
  destination?: string
  /** Set only after the dedicated plaintext-risk confirmation succeeds. */
  plaintextConfirmed?: boolean
}

export type RunBackupResult =
  | { ok: true; filename: string; sizeBytes: number; canceled: false }
  | { ok: true; canceled: true }
  | { ok: false; error: string }

export function useFullBackup() {
  const [busy, setBusy] = useState(false)

  const run = useCallback(async (args: RunBackupArgs): Promise<RunBackupResult> => {
    setBusy(true)
    try {
      if (args.encryption === "plaintext" && args.plaintextConfirmed !== true) {
        throw new Error("Plaintext backup requires explicit confirmation.")
      }
      const passphrase =
        args.encryption === "plaintext"
          ? undefined
          : args.encryption === "passphrase"
            ? args.passphrase
            : await getDefaultBackupPassphrase()
      if (args.encryption !== "plaintext" && !passphrase) {
        throw new Error("Encryption key unavailable on this runtime.")
      }
      const stream = buildBackupStream(args, {
        encryption: passphrase ? { passphrase } : undefined,
      })
      const historyEncryption = args.encryption === "plaintext" ? "none" : args.encryption
      const isEncrypted = args.encryption !== "plaintext"
      let sizeBytes = 0

      const fileName = defaultExportFileName(new Date(), isEncrypted ? "encrypted" : "plain")
      let writtenPath: string | null = null

      if (args.destination) {
        // Scheduled-backup path: caller resolved the destination already.
        if (isTauri()) {
          sizeBytes = await writeBackupStreamFile(args.destination, stream)
          writtenPath = args.destination
        } else {
          return { ok: false, error: "destination paths require the desktop app." }
        }
      } else if (isTauri()) {
        const { save } = await import("@tauri-apps/plugin-dialog")
        const path = await save({
          defaultPath: fileName,
          filters: [{ name: "Cognia backup", extensions: ["cbk", "json"] }],
        })
        if (!path) {
          setBusy(false)
          return { ok: true, canceled: true }
        }
        sizeBytes = await writeBackupStreamFile(path, stream)
        writtenPath = String(path)
      } else {
        const blob = await backupStreamBlob(stream)
        sizeBytes = blob.size
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = fileName
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 0)
      }

      await appendBackupHistory({
        completedAt: Date.now(),
        type: args.type ?? "manual",
        success: true,
        encryption: historyEncryption,
        sizeBytes,
        filename: writtenPath ? lastSegment(writtenPath) : fileName,
      })

      return { ok: true, filename: fileName, sizeBytes, canceled: false }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      try {
        await appendBackupHistory({
          completedAt: Date.now(),
          type: args.type ?? "manual",
          success: false,
          encryption:
            args.encryption === "plaintext"
              ? "none"
              : args.encryption === "auto-key"
                ? "auto-key"
                : "passphrase",
          errorMessage: message,
        })
      } catch {
        // Don't blow up the result reporting because logging failed.
      }
      return { ok: false, error: message }
    } finally {
      setBusy(false)
    }
  }, [])

  return { run, busy }
}

function lastSegment(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return slash >= 0 ? path.slice(slash + 1) : path
}
