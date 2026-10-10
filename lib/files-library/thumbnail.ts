/**
 * Which Files entries draw a picture instead of a glyph (ADR-0223): chat
 * images, and uploads whose bytes are an image — a duplicated image is a
 * Files-owned upload and must still look like one.
 */

import { isImageEntry } from "./filter"
import type { FilesEntry } from "./types"

/** The entry has image bytes the media cache can resolve. */
export function isThumbnailEntry(
  entry: Pick<FilesEntry, "kind" | "mediaType" | "sourceId" | "mediaHash">
): boolean {
  if (!isImageEntry(entry)) return false
  return entry.kind === "image" || typeof entry.mediaHash === "string"
}

/** The `messageMedia` key to acquire: an image's own hash, an upload's bytes. */
export function thumbnailHash(entry: Pick<FilesEntry, "kind" | "sourceId" | "mediaHash">): string {
  return entry.kind === "image" ? entry.sourceId : (entry.mediaHash ?? entry.sourceId)
}
