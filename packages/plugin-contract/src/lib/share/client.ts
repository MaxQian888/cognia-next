/**
 * The plugin contract's share of `lib/share/client.ts`, which re-exports these.
 */
import type { ShareBlobSource, ShareFileDescriptor } from "./blobs"
import type { SharePayload } from "./types"

/** One file to carry: what the manifest says about it, and how to read it. */
export interface CreateShareFile extends ShareFileDescriptor {
  /** Opened twice: once to hash, once to upload. */
  open: () => Promise<ShareBlobSource>
}

/** Where a file share's creation is. Bytes are plaintext bytes. */
export interface CreateShareProgress {
  phase: "hashing" | "uploading"
  /** Index into `files`. */
  fileIndex: number
  fileCount: number
  path: string
  /** Bytes of this phase done across all files. */
  done: number
  total: number
}

export interface CreateShareInput {
  payload: SharePayload
  ttlSeconds?: number
  maxViews?: number
  burnAfterRead?: boolean
  /** Optional extra passphrase, shared out-of-band (never in the URL). */
  passphrase?: string
  /** Local owner namespace used to authorize domain-specific revocation. */
  ownerScope?: string
  /** Files the share carries (ADR-0222). Policy is the caller's: see `lib/filespace/share-files.ts`. */
  files?: CreateShareFile[]
  /** The conversation the share is made from, recorded beside the link. */
  sessionId?: string
  onProgress?: (progress: CreateShareProgress) => void
  signal?: AbortSignal
}

export interface CreatedShare {
  code: string
  /** Full shareable URL including the `#fragment` key. */
  url: string
  expiresAt?: number
}
