"use client"

/**
 * Unified cross-platform single-file saver with location feedback.
 *
 * This is the missing shared unit the codebase needed: a saver that works on
 * ALL three shells (Tauri / Capacitor / web), accepts text *and* binary, and
 * reports *where* the file landed so callers can tell the user. Prior to this
 * module the save logic was duplicated across `use-single-export`,
 * `use-batch-export`, `message-list`, and `mobile-backup-section`, and the
 * Capacitor branch was simply missing — the `<a download>` anchor silently
 * no-ops inside a WKWebView / Android WebView, so mobile exports vanished.
 *
 * It does NOT reimplement primitives — it composes existing ones:
 *   - Tauri:     `@tauri-apps/plugin-dialog` save() + `@tauri-apps/plugin-fs`
 *                + `registerDialogPathInRust` (allowed-roots containment)
 *   - Capacitor: `lib/capacitor/filesystem.writeFile` (+ `encodeBase64`)
 *   - Web:       `lib/files/download.downloadBlob`
 *
 * `lib/files/file-bridge.ts:saveFileAs` is intentionally left untouched: it
 * serves the skills export flow through the Rust-confined write command and a
 * different (boolean) contract.
 */

import { isTauri, isCapacitor, type Platform } from "@/lib/platform/detect"
import { registerDialogPathInRust } from "@/lib/files/allowed-roots-sync"
import { writeFile as capacitorWriteFile, type Directory } from "@/lib/capacitor/filesystem"
import { downloadBlob } from "@/lib/files/download"
import { encodeBase64 } from "@/lib/share/encoding"

export type ExportData = string | Uint8Array | Blob

export interface SaveExportOptions {
  /** Suggested filename incl. extension (e.g. "cognia-chat-2026-06-17.md"). */
  filename: string
  data: ExportData
  mimeType: string
  /** Tauri save-dialog filter spec; derived from the filename extension when omitted. */
  filters?: { name: string; extensions: string[] }[]
  /** Capacitor sub-path under the chosen directory. Default "cognia/exports". */
  mobileSubdir?: string
  /** Capacitor base directory. Default "documents" (visible in the Files app). */
  mobileDirectory?: Directory
}

export type SaveExportOutcome =
  | { kind: "saved"; platform: Platform; location: string; uri?: string; filename: string }
  | { kind: "cancelled" }
  | { kind: "error"; message: string }

/** Save a file to disk on whichever platform we're running, returning where it went. */
export async function saveExport(opts: SaveExportOptions): Promise<SaveExportOutcome> {
  try {
    if (isTauri()) return await saveViaTauri(opts)
    if (isCapacitor()) {
      const outcome = await saveViaCapacitor(opts)
      // Capacitor reports "unsupported" only when the native plugin is missing
      // (e.g. running the mobile bundle in a plain browser) — fall back to a
      // web download so the export still completes.
      if (outcome.kind !== "unsupported") return outcome
    }
    return saveViaWeb(opts)
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) }
  }
}

async function saveViaTauri(opts: SaveExportOptions): Promise<SaveExportOutcome> {
  const { save } = await import("@tauri-apps/plugin-dialog")
  const fs = await import("@tauri-apps/plugin-fs")
  const ext = extOf(opts.filename)
  const filters = opts.filters ?? [{ name: ext.toUpperCase(), extensions: [ext] }]
  const path = await save({ defaultPath: opts.filename, filters })
  if (!path) return { kind: "cancelled" }
  // Bless the dialog-chosen directory so the Rust FS allowed-roots gate treats
  // this user-picked path as in-bounds (shadow-mode containment).
  await registerDialogPathInRust(path)
  if (typeof opts.data === "string") {
    await fs.writeTextFile(path, opts.data)
  } else {
    await fs.writeFile(path, await toBytes(opts.data))
  }
  return { kind: "saved", platform: "tauri", location: path, filename: opts.filename }
}

type CapacitorSaveOutcome = SaveExportOutcome | { kind: "unsupported" }

async function saveViaCapacitor(opts: SaveExportOptions): Promise<CapacitorSaveOutcome> {
  const subdir = opts.mobileSubdir ?? "cognia/exports"
  const path = `${subdir}/${opts.filename}`
  const base64 = await toBase64(opts.data)
  const out = await capacitorWriteFile({
    path,
    data: base64,
    encoding: "base64",
    directory: opts.mobileDirectory ?? "documents",
    recursive: true,
  })
  if (out.kind === "ok") {
    return {
      kind: "saved",
      platform: "mobile",
      location: out.value.uri,
      uri: out.value.uri,
      filename: opts.filename,
    }
  }
  if (out.kind === "unsupported") return { kind: "unsupported" }
  return { kind: "error", message: out.message }
}

function saveViaWeb(opts: SaveExportOptions): SaveExportOutcome {
  const blob =
    opts.data instanceof Blob
      ? opts.data
      : new Blob([opts.data as BlobPart], { type: opts.mimeType })
  downloadBlob(blob, opts.filename)
  return { kind: "saved", platform: "web", location: "downloads", filename: opts.filename }
}

// --- data conversion (reuses encodeBase64 — no bespoke base64 impl) ---------

async function toBytes(data: Exclude<ExportData, string>): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data
  return new Uint8Array(await data.arrayBuffer())
}

async function toBase64(data: ExportData): Promise<string> {
  if (typeof data === "string") return encodeBase64(new TextEncoder().encode(data))
  return encodeBase64(await toBytes(data))
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".")
  return dot >= 0 ? filename.slice(dot + 1) : "txt"
}
