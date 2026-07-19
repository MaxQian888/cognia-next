export interface BrowserPageSummary {
  id: string
  url: string
  title: string
  active: boolean
}

export interface BrowserDownloadSummary {
  id: string
  sessionId: string
  filename: string
  size: number
  state: "quarantined" | "saved" | "attached"
  savedRelativePath?: string
}

export type BrowserSessionErrorCode =
  | "browser_session_not_found"
  | "browser_session_quota_exceeded"
  | "browser_profile_in_use"
  | "browser_page_not_found"
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
