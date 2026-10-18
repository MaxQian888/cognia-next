/** Secret-free native projections. SIWC never participates in legacy ProviderId enumeration. */
export interface SiwcConnectionSummary {
  id: string
  email: string | null
  label: string
  issuer: string
  subject: string
  issuedClientId: string
  status: "connected" | "signed_out" | "reauth_required" | "plan_disabled"
  scopes: string[]
  expiresAtMs: number | null
  planPermission: boolean
}

export interface SiwcLoginAttempt {
  attemptId: string
}

export interface SiwcLoginProgress {
  status: "pending" | "complete" | "cancelled" | "error"
  connection?: SiwcConnectionSummary
  safeCode?: string
  /** Opaque draft reference for retrying the same issued client after an interrupted exchange. */
  retryConnectionId?: string
}

export interface SiwcSignOutResult {
  revocation: "confirmed" | "unconfirmed"
}

export interface SiwcModel {
  slug: string
  displayName: string
  visibility: string
}
