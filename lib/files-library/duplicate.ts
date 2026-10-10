/**
 * "Duplicate" from Files (ADR-0223). A copy is always the person's own and
 * independent of where the original lives:
 *
 * - a canvas document or an artifact becomes a new canvas document (an
 *   artifact cannot exist without a conversation; a canvas document can, and
 *   is editable);
 * - an image or a file becomes a Files-owned upload of the same bytes. The
 *   original bytes are content-addressed, so a copy of a file already held
 *   does not store them twice.
 *
 * The copy's name is the original's with a localized "(copy)" suffix, which
 * the caller supplies — this module carries no strings of its own.
 */

import { documentDraftOf } from "./document-draft"
import { downloadPayloadFor } from "./download"
import { uploadFileToLibrary } from "./upload"
import type { FilesEntry } from "./types"

export type FilesDuplicateResult = { kind: "canvas"; id: string } | { kind: "upload"; key: string }

export class FilesDuplicateError extends Error {
  constructor(readonly code: "files_source_missing") {
    super(code)
    this.name = "FilesDuplicateError"
  }
}

/** "notes.md" + " (copy)" → "notes (copy).md"; titles without an extension just gain the suffix. */
export function copyName(name: string, suffix: string, keepExtension: boolean): string {
  if (keepExtension) {
    const dot = name.lastIndexOf(".")
    if (dot > 0 && name.length - dot <= 8) return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`
  }
  return `${name}${suffix}`
}

export interface FilesDuplicateOptions {
  /** e.g. " (copy)" — prepended to an upload's extension, appended to a title. */
  suffix: string
  /** Name used when the original has none (an untitled image). */
  fallbackName: string
  projectId?: string
}

export async function duplicateFilesEntry(
  entry: FilesEntry,
  options: FilesDuplicateOptions
): Promise<FilesDuplicateResult> {
  const name = entry.title || options.fallbackName
  if (entry.kind === "canvas" || entry.kind === "artifact") {
    const { useArtifactStore } = await import("@/stores/artifact/artifact-store")
    const store = useArtifactStore.getState()
    const draft = documentDraftOf(entry, store)
    if (!draft) throw new FilesDuplicateError("files_source_missing")
    const id = store.createCanvasDocument({
      title: copyName(name, options.suffix, false),
      ...draft,
      createdBy: "user",
    })
    return { kind: "canvas", id }
  }

  const payload = await downloadPayloadFor(entry)
  if (!payload) throw new FilesDuplicateError("files_source_missing")
  const file = new File([payload.blob], copyName(payload.filename, options.suffix, true), {
    type: payload.blob.type || entry.mediaType || "application/octet-stream",
  })
  const uploaded = await uploadFileToLibrary(file, {
    asFile: true,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  })
  return { kind: "upload", key: uploaded.key }
}
