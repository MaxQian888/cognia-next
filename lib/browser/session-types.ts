import type {
  BrowserDownloadState,
  BrowserDownloadSummary,
} from "@cognia/plugin-contract/lib/browser/session-types"
export type {
  BrowserDownloadBackend,
  BrowserDownloadState,
  BrowserDownloadSummary,
  BrowserPageSummary,
} from "@cognia/plugin-contract/lib/browser/session-types"

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

/** Terminal states: nothing more will happen to the bytes on its own. */
export function isBrowserDownloadSettled(state: BrowserDownloadState): boolean {
  return state !== "in_progress"
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
