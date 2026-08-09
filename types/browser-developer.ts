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

export type CdpCapability = "dom" | "console" | "network" | "performance" | "runtime"

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
