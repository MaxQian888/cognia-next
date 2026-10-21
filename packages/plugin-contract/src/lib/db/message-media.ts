/**
 * The plugin contract's share of `lib/db/message-media.ts`, which re-exports these.
 */
export interface MessageMediaRow {
  /** SHA-256 of the canonical bytes, hex. The content address. */
  hash: string
  mediaType: string
  width: number
  height: number
  /** Canonical bytes: what renders inline and what the model is sent. */
  blob: Blob
  byteSize: number
  /** False only for a remote thumbnail cached before its canonical variant. */
  canonicalAvailable?: boolean
  /** Small preview for galleries and for holding space while the canonical decodes. */
  thumbBlob?: Blob
  thumbWidth?: number
  thumbHeight?: number
  /**
   * The user's original upload, kept only so "download" returns what they
   * gave us. Never rendered, never sent to a model. Absent for agent
   * screenshots, which have no original worth keeping.
   */
  originalBlob?: Blob
  originalByteSize?: number
  originalMediaType?: string
  createdAt: number
  /** Touched on read; orphan collection uses it to avoid evicting live media. */
  lastUsedAt: number
}
