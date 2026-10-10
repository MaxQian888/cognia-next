/**
 * Sharing a Files item (ADR-0223 §10) — dormant.
 *
 * Files shares through ADR-0222's file snapshot: a share link that carries
 * client-encrypted, chunked file blobs. Until that lands there is no way to
 * put a file's bytes behind a link (ADR-0037's payload holds 10 MiB of one
 * rendered page, not a file), so the Share entry is shown, labeled as not yet
 * available, and does nothing. Pinned by `share.test.ts` and by the item
 * menu's test; lifting it means replacing this marker with the real call.
 */

export const FILES_SHARE_DORMANCY = {
  surface: "files-share",
  reason: "awaiting-adr-0222-file-snapshots",
  /** What the person can do instead today. */
  remedy: "download",
} as const

/** False until ADR-0222's file snapshots exist; the menu renders the entry disabled. */
export function isFilesShareAvailable(): boolean {
  return false
}
