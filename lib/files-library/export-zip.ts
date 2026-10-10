/**
 * Export several Files entries as one zip (ADR-0223), built on this device
 * with fflate — nothing is uploaded.
 *
 * Each entry is written as its download (`downloadPayloadFor`): the original
 * bytes of an image or file, the text of an artifact or canvas document.
 * Entries filed in Folders keep their folder path inside the archive; the rest
 * sit at its root. Two entries with the same path get " (2)", " (3)" … before
 * the extension. Media that is already compressed is stored rather than
 * deflated again.
 *
 * The archive is assembled in memory, so its total size is capped; an export
 * above the cap fails before reading anything rather than exhausting memory
 * halfway.
 */

import { zip, type Zippable } from "fflate"

import { ROOT_LIBRARY_FOLDER_ID, type LibraryFolder } from "@/lib/db/files-library-types"

import { downloadPayloadFor, type FilesDownloadPayload } from "./download"
import { libraryFolderPath } from "./folder-tree"
import { safeFilename } from "./safe-filename"
import type { FilesEntry } from "./types"

/** Largest export assembled in memory. */
export const FILES_ZIP_MAX_BYTES = 512 * 1024 * 1024

export class FilesExportError extends Error {
  constructor(readonly code: "files_export_too_large" | "files_export_empty") {
    super(code)
    this.name = "FilesExportError"
  }
}

export interface FilesZipResult {
  blob: Blob
  /** Entries left out because their content is no longer stored. */
  missing: FilesEntry[]
  written: number
}

/** Media types whose bytes deflate no further. */
function isCompressed(mediaType: string): boolean {
  const type = mediaType.toLowerCase()
  return (
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    type.includes("zip") ||
    type.includes("compressed") ||
    type === "application/pdf"
  )
}

/** "a.txt" → "a (2).txt" for the n-th entry at the same path. */
export function numberedPath(path: string, n: number): string {
  const slash = path.lastIndexOf("/")
  const dir = path.slice(0, slash + 1)
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? `${dir}${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${dir}${name} (${n})`
}

/** The folder path an entry is written under (no leading or trailing slash). */
export function zipFolderPath(
  entry: Pick<FilesEntry, "folderId">,
  folders: readonly LibraryFolder[]
): string {
  if (!entry.folderId || entry.folderId === ROOT_LIBRARY_FOLDER_ID) return ""
  return libraryFolderPath(folders, entry.folderId)
    .map((folder) => safeFilename(folder.name, "folder"))
    .join("/")
}

export interface FilesZipDependencies {
  payloadFor: (entry: FilesEntry) => Promise<FilesDownloadPayload | null>
}

export async function buildFilesZip(
  entries: readonly FilesEntry[],
  folders: readonly LibraryFolder[],
  dependencies: Partial<FilesZipDependencies> = {}
): Promise<FilesZipResult> {
  if (entries.length === 0) throw new FilesExportError("files_export_empty")
  const known = entries.reduce((sum, entry) => sum + (entry.byteSize ?? 0), 0)
  if (known > FILES_ZIP_MAX_BYTES) throw new FilesExportError("files_export_too_large")
  const payloadFor = dependencies.payloadFor ?? downloadPayloadFor

  const files: Zippable = {}
  const taken = new Set<string>()
  const missing: FilesEntry[] = []
  let total = 0
  for (const entry of entries) {
    const payload = await payloadFor(entry)
    if (!payload) {
      missing.push(entry)
      continue
    }
    total += payload.blob.size
    if (total > FILES_ZIP_MAX_BYTES) throw new FilesExportError("files_export_too_large")
    const folder = zipFolderPath(entry, folders)
    const base = folder ? `${folder}/${payload.filename}` : payload.filename
    // Archive paths compare case-insensitively on the systems people unzip on.
    let path = base
    for (let n = 2; taken.has(path.toLowerCase()); n += 1) path = numberedPath(base, n)
    taken.add(path.toLowerCase())
    const bytes = new Uint8Array(await payload.blob.arrayBuffer())
    files[path] = [bytes, { level: isCompressed(payload.blob.type) ? 0 : 6 }]
  }
  const written = entries.length - missing.length
  if (written === 0) throw new FilesExportError("files_export_empty")
  const archive = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, (error, data) => (error ? reject(error) : resolve(data)))
  })
  return {
    blob: new Blob([archive as BlobPart], { type: "application/zip" }),
    missing,
    written,
  }
}
