/**
 * The plugin contract's share of `lib/data/session-assets-backup.ts`, which re-exports these.
 */
import type { MessageMediaRow } from "../db/message-media"

export interface MessageMediaBackupRow extends Omit<
  MessageMediaRow,
  "blob" | "thumbBlob" | "originalBlob"
> {
  blobHash: string
  thumbHash?: string
  thumbByteSize?: number
  thumbMediaType?: string
  originalHash?: string
}

export interface SessionAssetSourceChunk {
  contentHash: string
  offset: number
  /** Base64 of at most 48 KiB, avoiding full-source binary arrays. */
  data: string
}
