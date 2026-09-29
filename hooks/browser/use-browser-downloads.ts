"use client"

/**
 * The desktop browser's downloads (ADR-0201): the persistent feed that writes
 * every backend's download events into Dexie, the live list the Downloads
 * panel and toolbar badge read, and the per-row actions.
 *
 * The feed is reference-counted at module level. Several panes can be mounted
 * at once (dock panels stay mounted behind other tabs), and each subscribing
 * separately would write every progress tick once per pane.
 */

import { useCallback, useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import {
  cancelLocalDownload,
  isDownloadOpenBlocked,
  onBrowserDownload,
  openDownload,
  readDownload,
  revealDownload,
  saveDownloadAs,
} from "@/lib/browser/downloads-client"
import {
  clearBrowserDownloads,
  listBrowserDownloads,
  removeBrowserDownload,
  summaryToDownloadUpdate,
  upsertBrowserDownload,
  type BrowserDownloadRow,
} from "@/lib/db/browser-downloads"
import { isTauri } from "@/lib/tauri"
import { useSelectionToChat } from "@/hooks/browser/use-selection-to-chat"

let feedRefs = 0
let feedUnlisten: (() => void) | null = null
let feedStarting: Promise<void> | null = null

async function startFeed(): Promise<void> {
  const unlisten = await onBrowserDownload((summary) => {
    void upsertBrowserDownload(summaryToDownloadUpdate(summary)).catch(() => undefined)
  })
  if (feedRefs === 0) {
    unlisten()
    return
  }
  feedUnlisten = unlisten
}

/** Acquire the shared feed; the returned release drops it with the last user. */
export function acquireBrowserDownloadFeed(): () => void {
  feedRefs += 1
  if (feedRefs === 1 && !feedUnlisten && !feedStarting) {
    feedStarting = startFeed()
      .catch(() => undefined)
      .finally(() => {
        feedStarting = null
      })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    feedRefs -= 1
    if (feedRefs === 0 && feedUnlisten) {
      feedUnlisten()
      feedUnlisten = null
    }
  }
}

/** Test seam: forget every module-level subscription. */
export function resetBrowserDownloadFeedForTests(): void {
  feedUnlisten?.()
  feedUnlisten = null
  feedRefs = 0
  feedStarting = null
}

/** Persist desktop download events while mounted. A no-op off the desktop. */
export function useBrowserDownloadFeed(enabled: boolean = isTauri()): void {
  useEffect(() => {
    if (!enabled) return
    return acquireBrowserDownloadFeed()
  }, [enabled])
}

/** The download history, newest first, plus how many are still running. */
export function useBrowserDownloads(): {
  downloads: BrowserDownloadRow[]
  activeCount: number
} {
  const downloads = useLiveQuery(() => listBrowserDownloads({ limit: 200 }), [], []) ?? []
  const activeCount = downloads.filter((row) => row.state === "in_progress").length
  return { downloads, activeCount }
}

/** Which actions a row offers; the panel renders exactly these. */
export function downloadCapabilities(row: BrowserDownloadRow) {
  const localRuntime = row.backend === "local-chromium" || row.backend === "user-chrome"
  // A local "saved" row points at the copy the user picked in the save
  // dialog (Rust remembers it, so open/reveal accept it). A cloud "saved"
  // row lives in the remote workspace, not on this disk.
  const onDisk =
    !!row.savedPath &&
    (row.state === "completed" ||
      row.state === "attached" ||
      (localRuntime && row.state === "saved"))
  return {
    cancel:
      row.state === "in_progress" &&
      (row.backend === "local-chromium" || row.backend === "user-chrome"),
    // Copy a finished local-runtime download to where the user picks in a
    // native save dialog (`browser_download_save_as`).
    saveAs:
      localRuntime &&
      !!row.sessionId &&
      (row.state === "completed" || row.state === "attached" || row.state === "saved"),
    open: onDisk,
    reveal: onDisk,
    attach: onDisk,
    retry: !!row.url && (row.state === "failed" || row.state === "cancelled"),
    remove: row.state !== "in_progress",
  }
}

/**
 * `blocked`: Rust only opens safe document, media and archive types
 * (`download_open_blocked_executable`); the panel offers "show in folder".
 * `cancelled`: the user dismissed a native dialog (save as); nothing to report.
 */
export type DownloadActionOutcome =
  "ok" | "cancelled" | "failed" | "no-session" | "unsupported" | "too-large" | "blocked"

/**
 * Why `readDownload` refused. Rust (`browser_download_read`) only hands back
 * files inside the downloads folder or ones a download event reported, and
 * refuses anything over 64 MB with `download_too_large`.
 */
export function downloadReadFailure(error: unknown): "too-large" | "failed" {
  const text =
    typeof error === "string" ? error : error instanceof Error ? error.message : String(error)
  return text.includes("download_too_large") ? "too-large" : "failed"
}

export interface BrowserDownloadActions {
  cancel: (row: BrowserDownloadRow) => Promise<DownloadActionOutcome>
  saveAs: (row: BrowserDownloadRow) => Promise<DownloadActionOutcome>
  open: (row: BrowserDownloadRow) => Promise<DownloadActionOutcome>
  reveal: (row: BrowserDownloadRow) => Promise<DownloadActionOutcome>
  attach: (row: BrowserDownloadRow) => Promise<DownloadActionOutcome>
  remove: (row: BrowserDownloadRow) => Promise<DownloadActionOutcome>
  clear: () => Promise<DownloadActionOutcome>
}

/** Per-row actions. `chatSessionId` is where "attach" sends; default: focused chat. */
export function useBrowserDownloadActions(chatSessionId?: string): BrowserDownloadActions {
  const { sendFileBytes } = useSelectionToChat()

  const guard = useCallback(
    async (work: () => Promise<unknown>): Promise<DownloadActionOutcome> => {
      try {
        await work()
        return "ok"
      } catch {
        return "failed"
      }
    },
    []
  )

  const cancel = useCallback(
    (row: BrowserDownloadRow) =>
      guard(async () => {
        await cancelLocalDownload(row.sessionId, row.downloadId)
        await upsertBrowserDownload({
          backend: row.backend,
          downloadId: row.downloadId,
          state: "cancelled",
        })
      }),
    [guard]
  )

  const saveAs = useCallback(async (row: BrowserDownloadRow): Promise<DownloadActionOutcome> => {
    try {
      const saved = await saveDownloadAs(row.sessionId, row.downloadId)
      if (!saved) return "cancelled"
      // Same upsert path as the feed, pinned to this row's key: the runtime
      // summary may omit `backend`, which would otherwise default to remote.
      await upsertBrowserDownload({
        ...summaryToDownloadUpdate(saved),
        backend: row.backend,
        downloadId: row.downloadId,
        sessionId: saved.sessionId || row.sessionId,
      })
      return "ok"
    } catch {
      return "failed"
    }
  }, [])

  const open = useCallback(async (row: BrowserDownloadRow): Promise<DownloadActionOutcome> => {
    try {
      await openDownload(row.savedPath ?? "")
      return "ok"
    } catch (error) {
      return isDownloadOpenBlocked(error) ? "blocked" : "failed"
    }
  }, [])

  const reveal = useCallback(
    (row: BrowserDownloadRow) => guard(() => revealDownload(row.savedPath ?? "")),
    [guard]
  )

  const attach = useCallback(
    async (row: BrowserDownloadRow): Promise<DownloadActionOutcome> => {
      if (!row.savedPath) return "failed"
      try {
        let bytes: Uint8Array
        try {
          bytes = await readDownload(row.savedPath)
        } catch (error) {
          return downloadReadFailure(error)
        }
        const outcome = await sendFileBytes(
          bytes,
          { filename: row.filename, mimeType: row.mimeType, sourceUrl: row.url },
          { sessionId: chatSessionId }
        )
        if (outcome !== "sent") return outcome
        await upsertBrowserDownload({
          backend: row.backend,
          downloadId: row.downloadId,
          state: "attached",
        })
        return "ok"
      } catch {
        return "failed"
      }
    },
    [sendFileBytes, chatSessionId]
  )

  const remove = useCallback(
    (row: BrowserDownloadRow) => guard(() => removeBrowserDownload(row.id)),
    [guard]
  )

  const clear = useCallback(() => guard(() => clearBrowserDownloads()), [guard])

  return { cancel, saveAs, open, reveal, attach, remove, clear }
}
