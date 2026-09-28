/**
 * What "Download" hands the user for a Files entry (ADR-0200): the original
 * upload for images and files, the text for artifacts and canvas documents.
 */

import { getFileExtension } from "@/lib/canvas/utils"
import { getManyMessageMedia } from "@/lib/db/message-media"
import { getHeldSessionAssetSource, getLibraryAsset } from "@/lib/db/session-assets"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { FilesEntry } from "./types"

export interface FilesDownloadPayload {
  blob: Blob
  filename: string
}

/** Strip only what a filesystem refuses; keep non-ASCII titles readable. */
export function safeFilename(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180)
  return cleaned || fallback
}

function withExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(`.${extension.toLowerCase()}`) ? name : `${name}.${extension}`
}

function extensionOf(mediaType: string): string {
  const subtype = mediaType.split("/")[1]?.split("+")[0]?.toLowerCase()
  if (!subtype) return "bin"
  return subtype === "jpeg" ? "jpg" : subtype
}

/** Null when the source is gone (deleted elsewhere since the grid loaded). */
export async function downloadPayloadFor(entry: FilesEntry): Promise<FilesDownloadPayload | null> {
  switch (entry.kind) {
    case "artifact": {
      const artifact = useArtifactStore.getState().artifacts[entry.sourceId]
      if (!artifact) return null
      const extension = getFileExtension(
        artifact.language ?? (artifact.type === "document" ? "markdown" : artifact.type)
      )
      return {
        blob: new Blob([artifact.content], { type: "text/plain;charset=utf-8" }),
        filename: withExtension(safeFilename(artifact.title, "artifact"), extension),
      }
    }
    case "canvas": {
      const doc = useArtifactStore.getState().canvasDocuments[entry.sourceId]
      if (!doc) return null
      return {
        blob: new Blob([doc.content], { type: "text/plain;charset=utf-8" }),
        filename: withExtension(
          safeFilename(doc.title, "document"),
          getFileExtension(doc.language)
        ),
      }
    }
    case "image": {
      const [row] = await getManyMessageMedia([entry.sourceId])
      if (!row) return null
      const blob = row.originalBlob ?? row.blob
      const mediaType = row.originalBlob ? (row.originalMediaType ?? row.mediaType) : row.mediaType
      return {
        blob,
        filename: withExtension(
          safeFilename(entry.title, `image-${entry.sourceId.slice(0, 8)}`),
          extensionOf(mediaType)
        ),
      }
    }
    case "upload": {
      const asset = await getLibraryAsset(entry.sourceId)
      return asset ? { blob: asset.blob, filename: safeFilename(asset.filename, "file") } : null
    }
    case "session-upload": {
      const blob = await getHeldSessionAssetSource(entry.sourceId)
      return blob ? { blob, filename: safeFilename(entry.title, "file") } : null
    }
  }
}
