export type BrowserAdjustmentProperty = "font" | "text" | "spacing" | "color"

export interface BrowserAdjustmentChange {
  property: BrowserAdjustmentProperty
  cssProperty?: string
  before: string
  after: string
}

/** Structured feedback for a temporary live Browser Adjust preview. */
export interface BrowserAdjustmentFeedback {
  id: string
  sessionId: string
  browserSessionId: string
  pageUrl: string
  selector: string
  changes: BrowserAdjustmentChange[]
  previewState: "previewing" | "accepted" | "reverted"
  createdAt: number
  updatedAt: number
}

/**
 * What a developer-mode grant may reach.
 *
 * Deliberately narrower than the CDP domain list: the native side is an
 * `eval_with_callback` bridge over the embedded page, not a real CDP endpoint
 * (`src-tauri/src/browser/cdp.rs`), so `dom` and `runtime` are everything it
 * can honestly serve. Console and network output already have a first-class,
 * always-on home in the DevTools drawer, fed by the overlay's push channels
 * (`browser://console` / `browser://network`); offering them here as well
 * produced grants no action could ever spend. Performance had no backing at
 * all on either side.
 */
export type CdpCapability = "dom" | "runtime"

/** Explicit, expiring, session-bound authority for local embedded-browser CDP. */
export interface CdpGrant {
  id: string
  sessionId: string
  browserSessionId: string
  origin: string
  capabilities: CdpCapability[]
  grantedAt: number
  expiresAt: number
  revokedAt?: number
}

export type CdpAuditOutcome = "granted" | "used" | "rejected" | "revoked" | "expired"

/** Append-only metadata event. Request/response bodies and URL secrets are excluded. */
export interface CdpAuditEvent {
  id: string
  grantId?: string
  sessionId: string
  browserSessionId: string
  origin: string
  capability?: CdpCapability
  method?: string
  outcome: CdpAuditOutcome
  reason?: string
  createdAt: number
}
