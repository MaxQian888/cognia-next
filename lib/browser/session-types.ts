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

/**
 * Download lifecycle. Local / user Chromium and the embedded webview move
 * `in_progress → completed | cancelled | failed`; the cloud runtime keeps the
 * ADR-0085 quarantine semantics (`quarantined → saved | attached`).
 */
export const BROWSER_DOWNLOAD_STATES = [
  "in_progress",
  "completed",
  "cancelled",
  "failed",
  "quarantined",
  "saved",
  "attached",
] as const

export type BrowserDownloadState = (typeof BROWSER_DOWNLOAD_STATES)[number]

/** Terminal states: nothing more will happen to the bytes on its own. */
export function isBrowserDownloadSettled(state: BrowserDownloadState): boolean {
  return state !== "in_progress"
}

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

export function isBrowserDownloadSummary(value: unknown): value is BrowserDownloadSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === "string" &&
    typeof item.sessionId === "string" &&
    typeof item.filename === "string" &&
    typeof item.size === "number" &&
    typeof item.state === "string" &&
    (BROWSER_DOWNLOAD_STATES as readonly string[]).includes(item.state)
  )
}

export type BrowserSessionErrorCode =
  | "browser_session_not_found"
  | "browser_session_quota_exceeded"
  | "browser_profile_in_use"
  | "browser_page_not_found"
  /** An owner already holds its share of the shared session's pages (ADR-0214). */
  | "browser_page_quota_exceeded"
  | "browser_feature_unsupported"

export class BrowserSessionError extends Error {
  constructor(
    public readonly code: BrowserSessionErrorCode,
    message: string
  ) {
    super(message)
    this.name = "BrowserSessionError"
  }
}
