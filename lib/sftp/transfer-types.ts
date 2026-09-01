/**
 * What the SFTP transfer queue persists (ADR-0162).
 *
 * Split from `transfer-queue.ts` so `lib/db/schema.ts` can name the row type
 * without importing the runtime that drives it. The schema is loaded by every
 * shell at boot, and the queue pulls in `lib/sftp/client` and its transport.
 */

export type SftpTransferDirection = "download" | "upload"

/**
 * Where a transfer is.
 *
 * `paused` and `cancelled` are different answers and both are kept: a paused
 * row resumes from the bytes it already has, and a cancelled one is a decision
 * the user made that should not quietly restart on the next boot.
 *
 * `failed` carries the machine's own words. An SFTP server answers "Permission
 * denied" or "No space left on device", and paraphrasing that into a generic
 * message would throw away the only part a person can act on.
 */
export type SftpTransferStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled"

export interface SftpTransferRow {
  id: string
  /** The synchronized SSH profile. A device never names a destination. */
  profileId: string
  /** What to call the machine in the interface, captured when queued. */
  profileLabel: string
  /** Absolute path on the remote machine. */
  remotePath: string
  /** The leaf, for the row title and for the local download name. */
  fileName: string
  direction: SftpTransferDirection
  status: SftpTransferStatus
  /**
   * Total bytes, as known when the transfer was queued.
   *
   * For a download this is what the machine reported and it can move: something
   * else can append to the file while it is being read. The progress bar treats
   * it as an estimate, and the server's end-of-file is what actually stops the
   * read.
   */
  size: number
  transferred: number
  errorCode: string | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  /**
   * The bytes still to be sent, for an upload.
   *
   * Persisted so a transfer queued before a restart is still a transfer
   * afterwards rather than a row describing one. The host owns the write head,
   * so resuming needs only the source bytes and no local cursor.
   *
   * Bytes rather than a `Blob` for two reasons. A `Blob` handed to IndexedDB
   * survives in a real browser and comes back as `{}` under `fake-indexeddb`,
   * which would leave the single most important field in this row untested. And
   * the client works in bytes anyway, so the `Blob` was a wrapper this side put
   * on and took off again.
   */
  payload?: Uint8Array
  /**
   * What a download has received, partial or complete.
   *
   * Written when a transfer pauses, fails or finishes rather than on every
   * chunk: a multi-gigabyte download would otherwise rewrite a growing buffer
   * thousands of times, and being cheaper than starting again is the whole
   * point of resuming.
   *
   * A finished download keeps its bytes here until the user saves them. The row
   * is where the file is until then, so clearing it is losing the download.
   */
  received?: Uint8Array
}

/**
 * The largest file this queue will hold bytes for.
 *
 * Durability is what forces a limit: a transfer that survives a restart is one
 * whose bytes were written down, and browser storage is not unbounded. Refusing
 * with a number is better than accepting and dying somewhere between a
 * structured clone and a quota.
 */
export const SFTP_MAX_QUEUED_BYTES = 1024 * 1024 * 1024

export class SftpTransferTooLargeError extends Error {
  constructor(readonly size: number) {
    super(
      `this queue holds the bytes so a transfer survives a restart, and ${size} is over its ${SFTP_MAX_QUEUED_BYTES} byte limit`
    )
    this.name = "SftpTransferTooLargeError"
  }
}

/** Rows in one of these states will never move again on their own. */
export const SFTP_TERMINAL_STATUSES: readonly SftpTransferStatus[] = ["done", "failed", "cancelled"]

export function isSftpTransferFinished(status: SftpTransferStatus): boolean {
  return SFTP_TERMINAL_STATUSES.includes(status)
}
