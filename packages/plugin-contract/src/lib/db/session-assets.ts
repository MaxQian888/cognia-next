/**
 * The plugin contract's share of `lib/db/session-assets.ts`, which re-exports these.
 */
import type { AttachmentExtractedContent } from "@cognia/agent-config-types/attachment"

export interface SessionAsset {
  sessionId: string
  assetId: string
  contentHash: string
  filename: string
  mediaType: string
  byteSize: number
  extractedContent?: AttachmentExtractedContent
  createdAt: number
  updatedAt: number
  revision: number
  temporary: boolean
  /** False for remote/imported derived text whose original never reached this host. */
  sourceRetained?: boolean
  /** Content-free tombstone prevents stale transcript snapshots resurrecting a deleted asset. */
  deletedAt?: number
}
