// Small wire DTO leaf shared with the Node-only sidecar; avoid importing the app type barrel.
/** Opt-in execution feedback; never a grant or a replacement for task cancellation. */
export interface VerificationRuntimeConfig {
  enabled?: boolean
  maxBatchMs?: number
  verificationFraction?: number
  completionReserveMs?: number
}

/** One host-owned deadline, preserved across attempts of the same turn. */
export interface VerificationBudgetStamp {
  startedAtEpochMs: number
  deadlineEpochMs: number
  maxBatchMs?: number
  verificationFraction?: number
  completionReserveMs?: number
}
