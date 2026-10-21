/**
 * The plugin contract's share of `lib/browser/session-types.ts`, which re-exports these.
 */
import type { BROWSER_DOWNLOAD_STATES } from "@/lib/browser/session-types"

export interface BrowserPageSummary {
  id: string
  url: string
  title: string
  active: boolean
  /** The page that opened this one (a popup), when the runtime knows it. */
  openerId?: string
}

/** Which engine produced a download (ADR-0201). */
export type BrowserDownloadBackend = "embedded" | "local-chromium" | "user-chrome" | "remote"

export type BrowserDownloadState = (typeof BROWSER_DOWNLOAD_STATES)[number]

/**
 * One download as the runtime (`browser.downloads`, `download.updated`) and
 * the embedded webview (`browser://download`) report it. Metadata only: the
 * bytes stay on disk (`savedPath`) or in the cloud quarantine.
 */
export interface BrowserDownloadSummary {
  id: string
  sessionId: string
  filename: string
  /** Bytes on disk once finished; `receivedBytes` while in progress. */
  size: number
  url?: string
  mimeType?: string
  totalBytes?: number
  receivedBytes?: number
  /** Epoch ms. */
  startedAt?: number
  /** Epoch ms. */
  finishedAt?: number
  /** Absolute path in the Downloads directory (desktop backends). */
  savedPath?: string
  /** Workspace-relative path (cloud `saved` state). */
  savedRelativePath?: string
  error?: string
  backend?: BrowserDownloadBackend
  state: BrowserDownloadState
}
