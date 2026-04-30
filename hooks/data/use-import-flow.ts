"use client"

// Manages the import lifecycle: pick a file, detect encryption, prompt for
// passphrase if needed (with a silent auto-key try first), preview the v3
// package, then commit under the chosen merge strategy.
//
// The raw file text is held in a ref so a wrong passphrase can be retried
// without re-picking the file from disk. State transitions:
//   idle → loading → (needsPassphrase ↺) → preview → applying → done | error

import { useCallback, useEffect, useRef, useState } from "react"
import { pickAndReadFiles } from "@/lib/files/file-bridge"
import { createLogger } from "@/lib/logger"
import { decryptBackupPackage } from "@/lib/data/crypto"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { migrateEnvelope, isEncryptedEnvelope } from "@/lib/data/migrate"
import { applyBackupPackage } from "@/lib/data/apply-package"
import {
  IsEncryptedError,
  type BackupPackageV3,
  type ImportOptions,
  type ImportSummary,
} from "@/lib/data/types"

const log = createLogger("data-import")

export type ImportFlowState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "needsPassphrase"; lastError?: string }
  | { status: "preview"; pkg: BackupPackageV3 }
  | { status: "applying"; pkg: BackupPackageV3 }
  | { status: "done"; pkg: BackupPackageV3; summary: ImportSummary }
  | { status: "error"; message: string }

export function useImportFlow() {
  const [state, setState] = useState<ImportFlowState>({ status: "idle" })
  const stateRef = useRef<ImportFlowState>({ status: "idle" })
  useEffect(() => {
    stateRef.current = state
  }, [state])
  const rawRef = useRef<string | null>(null)

  const reset = useCallback(() => {
    rawRef.current = null
    setState({ status: "idle" })
  }, [])

  /** Open the OS picker (or web file input) and start the flow. */
  const pickFile = useCallback(async () => {
    setState({ status: "loading" })
    try {
      const picked = await pickAndReadFiles({
        filters: [{ name: "Cognia backup", extensions: ["cbk", "json"] }],
      })
      const raw = picked[0]?.content ?? null
      if (raw === null) {
        setState({ status: "idle" })
        return
      }
      rawRef.current = raw
      await dispatch(raw, setState)
    } catch (err) {
      log.error("import-pickFile-failed", { error: err })
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  /** Submit an explicit passphrase after a `needsPassphrase` step. */
  const submitPassphrase = useCallback(async (passphrase: string) => {
    const raw = rawRef.current
    if (!raw) {
      setState({ status: "error", message: "Lost the import buffer — pick the file again." })
      return
    }
    setState({ status: "loading" })
    try {
      const parsed = JSON.parse(raw)
      if (!isEncryptedEnvelope(parsed)) {
        setState({ status: "error", message: "File is not an encrypted backup." })
        return
      }
      const plaintext = await decryptBackupPackage(parsed, passphrase)
      const pkg = await migrateEnvelope(JSON.parse(plaintext))
      setState({ status: "preview", pkg })
    } catch (err) {
      log.warn("import-passphrase-rejected", { error: err })
      setState({
        status: "needsPassphrase",
        lastError: err instanceof Error ? err.message : String(err),
      })
    }
  }, [])

  /** Apply the previewed package under the chosen merge strategy. */
  const applyPreview = useCallback(async (opts: ImportOptions) => {
    const prev = stateRef.current
    if (prev.status !== "preview") return
    const pkg = prev.pkg
    setState({ status: "applying", pkg })
    try {
      const summary = await applyBackupPackage(pkg, opts)
      setState({ status: "done", pkg, summary })
    } catch (err) {
      log.error("import-apply-failed", {
        error: err,
        pkgVersion: pkg.manifest.version,
      })
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  return { state, pickFile, submitPassphrase, applyPreview, reset }
}

// ---------------------------------------------------------------------------

async function dispatch(
  raw: string,
  setState: React.Dispatch<React.SetStateAction<ImportFlowState>>
): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log.warn("import-invalid-json", { error: err })
    setState({
      status: "error",
      message: err instanceof Error ? err.message : "Invalid JSON.",
    })
    return
  }

  // Try the v1 / v3 path first; on `IsEncryptedError`, attempt auto-key
  // silently before falling back to a passphrase prompt.
  try {
    const pkg = await migrateEnvelope(parsed)
    setState({ status: "preview", pkg })
    return
  } catch (err) {
    if (err instanceof IsEncryptedError) {
      log.info("import-encrypted-detected")
      const autoKey = await getDefaultBackupPassphrase()
      if (autoKey) {
        try {
          const plaintext = await decryptBackupPackage(err.envelope, autoKey)
          const pkg = await migrateEnvelope(JSON.parse(plaintext))
          log.info("import-auto-key-success")
          setState({ status: "preview", pkg })
          return
        } catch (autoKeyErr) {
          log.info("import-auto-key-failed", { error: autoKeyErr })
          // Fall through to manual passphrase prompt.
        }
      }
      setState({ status: "needsPassphrase" })
      return
    }
    log.error("import-migrate-failed", { error: err })
    setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
  }
}
