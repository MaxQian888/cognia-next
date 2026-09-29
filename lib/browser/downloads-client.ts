/**
 * Downloads across desktop backends (ADR-0201).
 *
 * - Directory + reveal/open: `src-tauri/src/browser/downloads.rs`. The
 *   directory is picked in a native folder picker Rust shows
 *   (`chooseDownloadsDir`); the renderer never names a path. Reveal, open and
 *   read only accept paths a download already reported, so a renderer cannot
 *   use them as a generic opener; open only launches safe document, media and
 *   archive types (`download_open_blocked_executable` otherwise: reveal it).
 * - Embedded webview: Rust emits `browser://download` (`requested`, `finished`).
 * - Local / user Chromium: the runtime publishes `download.updated`, re-emitted
 *   as `browser-local://event`; cancel is a runtime op. The runtime's
 *   `browser.download.save` is Rust-only (`browser_download_save_as`, which
 *   asks for the target in a native save dialog).
 *
 * `onBrowserDownload` folds both streams into one `BrowserDownloadSummary`
 * feed so the Downloads panel and history table read a single shape.
 */
import type { UnlistenFn } from "@tauri-apps/api/event"

import { localBrowser, toFrameBytes } from "@/lib/browser/local-client"
import { isBrowserDownloadSummary, type BrowserDownloadSummary } from "@/lib/browser/session-types"
import { transport } from "@/lib/tauri"

export const EMBEDDED_DOWNLOAD_EVENT = "browser://download"

/** The embedded webview has one page; its downloads share this session id. */
export const EMBEDDED_DOWNLOAD_SESSION_ID = "embedded"

export interface BrowserDownloadsDir {
  path: string
  isDefault: boolean
  askWhereToSave: boolean
}

export interface EmbeddedDownloadEvent {
  phase: "requested" | "finished"
  id: string
  url: string
  filename: string
  savedPath?: string | null
  success?: boolean | null
  error?: string | null
}

export function getDownloadsDir(): Promise<BrowserDownloadsDir> {
  return transport.call<BrowserDownloadsDir>("browser_downloads_dir_get")
}

/**
 * Let the user pick the Downloads directory in a native folder picker (Rust
 * refuses home itself, filesystem roots and system directories). Resolves to
 * `null` when the picker was cancelled.
 */
export function chooseDownloadsDir(askWhereToSave: boolean): Promise<BrowserDownloadsDir | null> {
  return transport.call<BrowserDownloadsDir | null>("browser_downloads_dir_choose", {
    askWhereToSave,
  })
}

/** Restore the OS Downloads directory (keeps "ask where to save"). */
export function resetDownloadsDir(): Promise<BrowserDownloadsDir> {
  return transport.call<BrowserDownloadsDir>("browser_downloads_dir_reset")
}

/** Toggle "ask where to save"; the directory is unchanged. */
export function setAskWhereToSave(askWhereToSave: boolean): Promise<BrowserDownloadsDir> {
  return transport.call<BrowserDownloadsDir>("browser_downloads_dir_set", { askWhereToSave })
}

/** The error Rust returns when `openDownload` refuses a file type. */
export const DOWNLOAD_OPEN_BLOCKED = "download_open_blocked_executable"

/** Whether a rejected `openDownload` means "this type is not opened; reveal it". */
export function isDownloadOpenBlocked(error: unknown): boolean {
  const text =
    typeof error === "string" ? error : error instanceof Error ? error.message : String(error)
  return text.includes(DOWNLOAD_OPEN_BLOCKED)
}

export function revealDownload(path: string): Promise<void> {
  return transport.call<void>("browser_download_reveal", { path })
}

export function openDownload(path: string): Promise<void> {
  return transport.call<void>("browser_download_open", { path })
}

/**
 * Read a finished download's bytes (for attaching it to a chat). Rust answers
 * with a raw `tauri::ipc::Response`, which arrives as an `ArrayBuffer`; older
 * transports may hand back a typed array or a JSON byte array. Same path rule
 * as reveal/open: the path must have been reported by a download event.
 */
export async function readDownload(path: string): Promise<Uint8Array> {
  const raw = await transport.call<unknown>("browser_download_read", { path })
  const bytes = toFrameBytes(raw)
  if (!bytes) throw new Error("browser_download_read returned no bytes")
  return bytes
}

export function cancelLocalDownload(
  sessionId: string,
  downloadId: string
): Promise<BrowserDownloadSummary> {
  return localBrowser.rpc<BrowserDownloadSummary>("browser.download.cancel", {
    sessionId,
    downloadId,
  })
}

/**
 * Copy a finished local / user-Chrome download to a location the user picks
 * in a native save dialog (`browser_download_save_as`). The renderer never
 * names the target: Rust shows the dialog, then runs the Rust-only runtime op
 * `browser.download.save`. Resolves to the runtime's saved summary (`state:
 * "saved"`, `savedPath`), or `null` when the user cancelled the dialog.
 */
export function saveDownloadAs(
  sessionId: string,
  downloadId: string
): Promise<BrowserDownloadSummary | null> {
  return transport.call<BrowserDownloadSummary | null>("browser_download_save_as", {
    sessionId,
    downloadId,
  })
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/**
 * Normalize one embedded event. `previous` is the summary the same id produced
 * before (so `finished` keeps `startedAt`); `now` is injectable for tests.
 */
export function embeddedDownloadToSummary(
  event: EmbeddedDownloadEvent,
  previous: BrowserDownloadSummary | undefined,
  now: number
): BrowserDownloadSummary {
  const base: BrowserDownloadSummary = {
    id: event.id,
    sessionId: EMBEDDED_DOWNLOAD_SESSION_ID,
    filename: event.filename || (event.savedPath ? basename(event.savedPath) : event.id),
    size: previous?.size ?? 0,
    url: event.url || previous?.url,
    backend: "embedded",
    startedAt: previous?.startedAt ?? now,
    state: "in_progress",
  }
  if (event.phase === "requested") return base
  const savedPath = event.savedPath ?? previous?.savedPath
  if (event.success === false || event.error) {
    return {
      ...base,
      ...(savedPath ? { savedPath } : {}),
      finishedAt: now,
      state: "failed",
      error: event.error ?? "download_failed",
    }
  }
  return {
    ...base,
    ...(savedPath ? { savedPath, filename: event.filename || basename(savedPath) } : {}),
    finishedAt: now,
    state: "completed",
  }
}

export interface BrowserDownloadFeedOptions {
  now?: () => number
}

/**
 * Subscribe to every desktop download source. Resolves to one unlisten that
 * detaches both listeners.
 */
export async function onBrowserDownload(
  callback: (download: BrowserDownloadSummary) => void,
  options: BrowserDownloadFeedOptions = {}
): Promise<UnlistenFn> {
  const now = options.now ?? (() => Date.now())
  const embeddedSeen = new Map<string, BrowserDownloadSummary>()
  const unlistenEmbedded = transport.subscribe<EmbeddedDownloadEvent>(
    EMBEDDED_DOWNLOAD_EVENT,
    (event) => {
      if (!event || typeof event.id !== "string" || !event.phase) return
      const summary = embeddedDownloadToSummary(event, embeddedSeen.get(event.id), now())
      if (summary.state === "in_progress") embeddedSeen.set(event.id, summary)
      else embeddedSeen.delete(event.id)
      callback(summary)
    }
  )
  let unlistenLocal: UnlistenFn = () => {}
  try {
    unlistenLocal = await localBrowser.onEvent((event) => {
      if (event.type !== "download.updated") return
      if (!isBrowserDownloadSummary(event.download)) return
      callback({ ...event.download, sessionId: event.download.sessionId || event.sessionId })
    })
  } catch (error) {
    unlistenEmbedded()
    throw error
  }
  return () => {
    unlistenEmbedded()
    unlistenLocal()
  }
}

/**
 * "Attach this download to the chat" — the agent's `browser_download
 * {action:"attach"}` and the Downloads panel's button share one request. The
 * composer that owns `chatSessionId` CLAIMS it synchronously (same claim
 * pattern as `lib/browser/open-url-request.ts`) and adds the file as an
 * attachment; an unclaimed request means no surface could take it.
 */
export const BROWSER_DOWNLOAD_ATTACH_EVENT = "cognia:browser:attach-download"

export interface BrowserDownloadAttachRequest {
  download: BrowserDownloadSummary
  /** The chat the file should land in. */
  chatSessionId: string
  claimed: boolean
}

export function requestBrowserDownloadAttach(
  download: BrowserDownloadSummary,
  chatSessionId: string
): boolean {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return false
  const detail: BrowserDownloadAttachRequest = { download, chatSessionId, claimed: false }
  window.dispatchEvent(new CustomEvent(BROWSER_DOWNLOAD_ATTACH_EVENT, { detail }))
  return detail.claimed
}

/** Subscribe a composer; return true from the handler to claim the request. */
export function onBrowserDownloadAttachRequest(
  handler: (request: BrowserDownloadAttachRequest) => boolean
): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => {}
  }
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<BrowserDownloadAttachRequest>).detail
    if (!detail || detail.claimed || !isBrowserDownloadSummary(detail.download)) return
    if (handler(detail)) detail.claimed = true
  }
  window.addEventListener(BROWSER_DOWNLOAD_ATTACH_EVENT, listener)
  return () => window.removeEventListener(BROWSER_DOWNLOAD_ATTACH_EVENT, listener)
}
