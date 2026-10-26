/**
 * The plugin contract's share of `lib/share/blobs.ts`, which re-exports these.
 */
/** Bytes of one file, read a slice at a time. */
export interface ShareBlobSource {
  /** Plaintext size when the source was opened. */
  size: number
  /**
   * Exactly `length` bytes from `offset`, or a rejection. A source whose
   * bytes or size moved under it rejects with {@link ShareFileChangedError}.
   */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
}

/** What a manifest row needs beyond the bytes. */
export interface ShareFileDescriptor {
  /** FileSpace path at share time. */
  path: string
  name: string
  mime: string
}
