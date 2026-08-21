"use client"

// Encapsulates the full export flow: build the v3 package, optionally encrypt,
// open the save dialog (Tauri) or trigger a download (web), then record the
// outcome in `backupHistory`. Errors are returned to the caller as an
// { ok: false, error } shape so the UI can render inline messages instead of
// shouting to a toast for every failure path.

import { useCallback, useState } from "react"
import { isTauri } from "@/lib/tauri"
import {
  buildBackupPackage,
  defaultExportFileName,
  serializePackage,
} from "@/lib/data/build-package"
import { encryptBackupPackage } from "@/lib/data/crypto"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { appendBackupHistory } from "@/lib/db/backup-history"
import type { BackupHistoryEncryption, BackupHistoryType } from "@/lib/db/backup-history"
import type { ExportOptions } from "@/lib/data/types"
import type { EncryptionMode } from "@/components/data/shared/encryption-options"
import { attachPortableRetrievalKeys } from "@/lib/data/retrieval-key-backup"

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
      const basePackage = await buildBackupPackage({
        includeSessions: args.includeSessions,
        includeApiKey: args.includeApiKey,
        includeBuiltIns: args.includeBuiltIns,
      })
      const pkg = passphrase
        ? await attachPortableRetrievalKeys(basePackage, passphrase)
        : basePackage
      const plaintext = serializePackage(pkg)

      let body: string
      let historyEncryption: BackupHistoryEncryption
      const isEncrypted = args.encryption !== "plaintext"
      if (args.encryption === "plaintext") {
        body = plaintext
        historyEncryption = "none"
      } else {
        // Non-null by the guard above: this branch is `encryption !== "plaintext"`,
        // and that combination already threw. TS cannot correlate the two
        // conditions across the intervening statements.
        const env = await encryptBackupPackage(plaintext, passphrase!, {
          version: pkg.manifest.version,
          schemaVersion: pkg.manifest.schemaVersion,
          traceId: pkg.manifest.traceId,
          exportedAt: pkg.manifest.exportedAt,
          appVersion: pkg.manifest.appVersion,
          backend: pkg.manifest.backend,
          encryption: { enabled: true, format: "encrypted-envelope-v1" },
        })
        body = JSON.stringify(env, null, 2)
        historyEncryption = args.encryption === "auto-key" ? "auto-key" : "passphrase"
      }

      const fileName = defaultExportFileName(new Date(), isEncrypted ? "encrypted" : "plain")
      let writtenPath: string | null = null

      if (args.destination) {
        // Scheduled-backup path: caller resolved the destination already.
        if (isTauri()) {
          const { writeTextFile } = await import("@tauri-apps/plugin-fs")
          await writeTextFile(args.destination, body)
          writtenPath = args.destination
        } else {
          return { ok: false, error: "destination paths require the desktop app." }
        }
      } else if (isTauri()) {
        const { save } = await import("@tauri-apps/plugin-dialog")
        const { writeTextFile } = await import("@tauri-apps/plugin-fs")
        const path = await save({
          defaultPath: fileName,
          filters: [{ name: "Cognia backup", extensions: ["cbk", "json"] }],
        })
        if (!path) {
          setBusy(false)
          return { ok: true, canceled: true }
        }
        await writeTextFile(path, body)
        writtenPath = String(path)
      } else {
        const blob = new Blob([body], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = fileName
        a.click()
        URL.revokeObjectURL(url)
      }

      const sizeBytes = body.length
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
