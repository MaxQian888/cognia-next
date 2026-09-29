/**
 * CRUD for `browserDownloads` (schema v232, ADR-0201) — the desktop browser's
 * download history.
 *
 * Every desktop backend reports downloads differently: the embedded webview
 * emits `browser://download` (`requested` / `finished`), local and user Chromium
 * stream `download.updated` over `browser-local://event`, and the cloud runtime
 * answers `browser.downloads`. The Downloads panel reads one list, so each of
 * those feeds lands here through {@link upsertBrowserDownload}.
 *
 * Only metadata is stored — the bytes stay wherever the backend saved them (the
 * user's Downloads folder on the desktop). The primary key is
 * `${backend}:${downloadId}` because two backends mint ids independently and a
 * collision would merge two unrelated files into one row.
 *
 * Capped at {@link MAX_BROWSER_DOWNLOAD_ROWS}: after each write the oldest
 * FINISHED rows are trimmed. A download still in progress is never trimmed, so
 * the panel cannot lose the cancel button for something that is still running.
 */

import {
  isBrowserDownloadSettled,
  type BrowserDownloadBackend,
  type BrowserDownloadState,
  type BrowserDownloadSummary,
} from "@/lib/browser/session-types"

import { getDb } from "./schema"

export type { BrowserDownloadBackend, BrowserDownloadState }

/** Rows kept before the oldest finished ones are trimmed. */
export const MAX_BROWSER_DOWNLOAD_ROWS = 1_000

export interface BrowserDownloadRow {
  /** `${backend}:${downloadId}` — see the module comment. */
  id: string
  /** The id the backend itself uses (what cancel / delete / save address). */
  downloadId: string
  /** The browser session that produced it; `embedded` for the webview. */
  sessionId: string
  backend: BrowserDownloadBackend
  state: BrowserDownloadState
  filename: string
  url?: string
  mimeType?: string
  totalBytes?: number
  receivedBytes?: number
  /** Final size in bytes, 0 while unknown. */
  size: number
  startedAt: number
  finishedAt?: number
  /** Absolute path on this machine once the file is on disk. */
  savedPath?: string
  /** Cloud-only: the workspace-relative path a quarantined file was saved to. */
  savedRelativePath?: string
  error?: string
  updatedAt: number
}

/** What a feed reports; everything but the identity is optional and merged. */
export type BrowserDownloadUpdate = Pick<BrowserDownloadRow, "downloadId" | "backend"> &
  Partial<Omit<BrowserDownloadRow, "id" | "downloadId" | "backend" | "updatedAt">>

export function browserDownloadKey(backend: BrowserDownloadBackend, downloadId: string): string {
  return `${backend}:${downloadId}`
}

/**
 * The history update a runtime / webview summary maps to. A summary that does
 * not say which backend produced it came from the cloud runtime (ADR-0085), the
 * only feed that predates the field.
 */
export function summaryToDownloadUpdate(summary: BrowserDownloadSummary): BrowserDownloadUpdate {
  return {
    downloadId: summary.id,
    backend: summary.backend ?? "remote",
    sessionId: summary.sessionId,
    state: summary.state,
    filename: summary.filename,
    size: summary.size,
    url: summary.url,
    mimeType: summary.mimeType,
    totalBytes: summary.totalBytes,
    receivedBytes: summary.receivedBytes,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    savedPath: summary.savedPath,
    savedRelativePath: summary.savedRelativePath,
    error: summary.error,
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [key, entry] of Object.entries(value) as [keyof T, T[keyof T]][]) {
    if (entry !== undefined) out[key] = entry
  }
  return out
}

/**
 * Merge a feed's report into the stored row, creating it on first sight.
 *
 * Two ordering hazards are handled here rather than by each feed:
 * - a late `in_progress` progress tick arriving after the terminal event must
 *   not resurrect a finished download (the event bus does not guarantee order);
 * - `startedAt` is the first time the download was seen, whatever later
 *   reports claim, so the list order is stable.
 */
export async function upsertBrowserDownload(
  update: BrowserDownloadUpdate,
  now: number = Date.now()
): Promise<BrowserDownloadRow> {
  const db = getDb()
  const id = browserDownloadKey(update.backend, update.downloadId)
  return db.transaction("rw", db.browserDownloads, async () => {
    const existing = await db.browserDownloads.get(id)
    const patch = stripUndefined(update)
    let state: BrowserDownloadState = patch.state ?? existing?.state ?? "in_progress"
    if (existing && isBrowserDownloadSettled(existing.state) && state === "in_progress") {
      state = existing.state
    }
    const merged: BrowserDownloadRow = {
      sessionId: "embedded",
      filename: "",
      size: 0,
      ...existing,
      ...patch,
      id,
      downloadId: update.downloadId,
      backend: update.backend,
      state,
      startedAt: existing?.startedAt ?? patch.startedAt ?? now,
      updatedAt: now,
    }
    if (isBrowserDownloadSettled(state) && merged.finishedAt === undefined) {
      merged.finishedAt = now
    }
    if (!merged.size && merged.receivedBytes && state !== "in_progress") {
      merged.size = merged.receivedBytes
    }
    await db.browserDownloads.put(merged)
    const overflow = (await db.browserDownloads.count()) - MAX_BROWSER_DOWNLOAD_ROWS
    if (overflow > 0) {
      const oldest = await db.browserDownloads
        .orderBy("startedAt")
        .filter((row) => row.state !== "in_progress" && row.id !== id)
        .limit(overflow)
        .primaryKeys()
      await db.browserDownloads.bulkDelete(oldest)
    }
    return merged
  })
}

export interface ListBrowserDownloadsOptions {
  /** Only this browser session's downloads. */
  sessionId?: string
  limit?: number
}

/** Newest first. */
export async function listBrowserDownloads(
  options: ListBrowserDownloadsOptions = {}
): Promise<BrowserDownloadRow[]> {
  const db = getDb()
  let collection = db.browserDownloads.orderBy("startedAt").reverse()
  if (options.sessionId) {
    const sessionId = options.sessionId
    collection = collection.filter((row) => row.sessionId === sessionId)
  }
  if (options.limit !== undefined) collection = collection.limit(options.limit)
  return collection.toArray()
}

/** "Remove from list": forgets the entry, never touches the file on disk. */
export async function removeBrowserDownload(id: string): Promise<void> {
  await getDb().browserDownloads.delete(id)
}

/**
 * "Clear list": forgets every finished download. Running ones stay, because
 * dropping them would orphan a download the user can then no longer cancel.
 */
export async function clearBrowserDownloads(): Promise<number> {
  const db = getDb()
  const finished = await db.browserDownloads
    .filter((row) => row.state !== "in_progress")
    .primaryKeys()
  await db.browserDownloads.bulkDelete(finished)
  return finished.length
}
