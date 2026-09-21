"use client"

// Manages the import lifecycle: pick a file, detect encryption, prompt for
// passphrase if needed (with a silent auto-key try first), preview the v3
// package, then commit under the chosen merge strategy.
//
// The raw file text is held in a ref so a wrong passphrase can be retried
// without re-picking the file from disk. State transitions:
//   idle → loading → (needsPassphrase ↺) → preview → applying → done | error

import { useCallback, useEffect, useRef, useState } from "react"
import { pickStreamFiles, type PickedStreamFile } from "@/lib/files/file-bridge"
import { createLogger } from "@cognia/logging"
import { decryptBackupPackage } from "@/lib/data/crypto"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { migrateEnvelope, isEncryptedEnvelope } from "@/lib/data/migrate"
import { readStreamPackage, type ReadStreamPackageResult } from "@/lib/data/read-stream-package"
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
  const operationRef = useRef(0)
  useEffect(
    () => () => {
      operationRef.current += 1
    },
    []
  )
  const rawRef = useRef<string | null>(null)
  const streamRef = useRef<PickedStreamFile | null>(null)
  const streamExtrasRef = useRef<ReadStreamPackageResult["extras"]>({})
  const retrievalDekPassphraseRef = useRef<string | null>(null)

  const reset = useCallback(() => {
    operationRef.current += 1
    rawRef.current = null
    streamRef.current = null
    streamExtrasRef.current = {}
    retrievalDekPassphraseRef.current = null
    setState({ status: "idle" })
  }, [])

  /** Open the OS picker (or web file input) and start the flow. */
  const pickFile = useCallback(async () => {
    const operation = ++operationRef.current
    const current = () => operationRef.current === operation
    const setCurrentState: typeof setState = (next) => {
      if (current()) setState(next)
    }
    setState({ status: "loading" })
    try {
      const picked = await pickStreamFiles({
        filters: [{ name: "Cognia backup", extensions: ["cbk", "json"] }],
      })
      if (!current()) return
      const file = picked[0]
      if (!file) {
        setState({ status: "idle" })
        return
      }
      rawRef.current = null
      streamRef.current = null
      streamExtrasRef.current = {}
      retrievalDekPassphraseRef.current = null
      const detected = await inspectImportFile(guardImportFile(file, current))
      if (!current()) return
      if (detected.stream) {
        streamRef.current = file
        const key = detected.encrypted ? await getDefaultBackupPassphrase() : undefined
        if (!current()) return
        if (detected.encrypted && !key) {
          setState({ status: "needsPassphrase" })
          return
        }
        try {
          const restored = await readStreamPackage(
            guardImportFile(file, current).stream(),
            key ?? undefined
          )
          if (!current()) return
          streamExtrasRef.current = restored.extras
          retrievalDekPassphraseRef.current = key ?? null
          setState({ status: "preview", pkg: restored.pkg })
        } catch (error) {
          if (!current()) return
          if (!detected.encrypted) throw error
          setState({ status: "needsPassphrase" })
        }
      } else {
        rawRef.current = detected.raw
        await dispatch(detected.raw, setCurrentState, (passphrase) => {
          if (current()) retrievalDekPassphraseRef.current = passphrase
        })
      }
    } catch (err) {
      if (!current()) return
      log.error("import-pickFile-failed", { error: err })
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  /** Submit an explicit passphrase after a `needsPassphrase` step. */
  const submitPassphrase = useCallback(async (passphrase: string) => {
    const operation = ++operationRef.current
    const current = () => operationRef.current === operation
    const raw = rawRef.current
    if (!raw && !streamRef.current) {
      setState({ status: "error", message: "Lost the import buffer — pick the file again." })
      return
    }
    setState({ status: "loading" })
    try {
      if (streamRef.current) {
        const restored = await readStreamPackage(
          guardImportFile(streamRef.current, current).stream(),
          passphrase
        )
        if (!current()) return
        streamExtrasRef.current = restored.extras
        retrievalDekPassphraseRef.current = passphrase
        setState({ status: "preview", pkg: restored.pkg })
        return
      }
      const parsed = JSON.parse(raw!)
      if (!isEncryptedEnvelope(parsed)) {
        setState({ status: "error", message: "File is not an encrypted backup." })
        return
      }
      const plaintext = await decryptBackupPackage(parsed, passphrase)
      const pkg = await migrateEnvelope(JSON.parse(plaintext))
      if (!current()) return
      retrievalDekPassphraseRef.current = passphrase
      setState({ status: "preview", pkg })
    } catch (err) {
      if (!current()) return
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
    const operation = ++operationRef.current
    const current = () => operationRef.current === operation
    const pkg = prev.pkg
    setState({ status: "applying", pkg })
    try {
      const summary = await applyBackupPackage(
        pkg,
        {
          ...opts,
          retrievalDekPassphrase: retrievalDekPassphraseRef.current ?? undefined,
        },
        streamExtrasRef.current
      )
      if (!current()) return
      streamExtrasRef.current = {}
      streamRef.current = null
      rawRef.current = null
      retrievalDekPassphraseRef.current = null
      setState({ status: "done", pkg, summary })
    } catch (err) {
      if (!current()) return
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
  setState: React.Dispatch<React.SetStateAction<ImportFlowState>>,
  setRetrievalDekPassphrase: (passphrase: string | null) => void
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
    setRetrievalDekPassphrase(null)
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
          setRetrievalDekPassphrase(autoKey)
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

async function inspectImportFile(
  file: PickedStreamFile
): Promise<{ stream: true; encrypted: boolean } | { stream: false; raw: string }> {
  const prefix: Uint8Array[] = []
  let prefixBytes = 0
  for await (const bytes of file.stream()) {
    const end = bytes.indexOf(10)
    const part = end < 0 ? bytes : bytes.subarray(0, end)
    prefix.push(part)
    prefixBytes += part.byteLength
    if (end >= 0 || prefixBytes > 16 * 1024 * 1024) break
  }
  if (prefixBytes <= 16 * 1024 * 1024) {
    const headerBytes = new Uint8Array(prefixBytes)
    let offset = 0
    for (const part of prefix) {
      headerBytes.set(part, offset)
      offset += part.length
    }
    try {
      const header = JSON.parse(new TextDecoder().decode(headerBytes)) as {
        format?: string
        encryption?: unknown
      }
      if (header?.format === "cognia-backup-stream")
        return { stream: true, encrypted: !!header.encryption }
    } catch {
      /* Legacy JSON can span lines; its parser reports malformed files below. */
    }
  }
  const parts: string[] = []
  const decoder = new TextDecoder(undefined, { fatal: true })
  let size = 0
  for await (const bytes of file.stream()) {
    size += bytes.byteLength
    if (size > 128 * 1024 * 1024)
      throw new Error(
        "This legacy JSON backup is too large to restore safely. Re-export it as a local streaming backup from the source device."
      )
    parts.push(decoder.decode(bytes, { stream: true }))
  }
  parts.push(decoder.decode())
  return { stream: false, raw: parts.join("") }
}

function guardImportFile(file: PickedStreamFile, current: () => boolean): PickedStreamFile {
  return {
    ...file,
    stream: async function* () {
      for await (const bytes of file.stream()) {
        if (!current()) throw new DOMException("Import canceled", "AbortError")
        yield bytes
      }
      if (!current()) throw new DOMException("Import canceled", "AbortError")
    },
  }
}
