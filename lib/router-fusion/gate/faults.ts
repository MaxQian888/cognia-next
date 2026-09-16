/**
 * What counts as a Router + Fusion infrastructure fault (ADR-0188 D38).
 *
 * The distinction decides what the user sees:
 * - an INFRASTRUCTURE fault (the fusion database will not open, a transaction
 *   aborts, a module fails to import, the brain bridge times out, the content
 *   cipher is locked, or plain internal exception) sends ordinary traffic back
 *   to the original path with a visible "not ledgered" notice, and counts
 *   towards the surface breaker;
 * - a REFUSAL (budget, model-call limit, deadline, no route that satisfies the
 *   hard filters) is the system working as specified. It is never a fault, never
 *   bypassed, and never trips a breaker.
 *
 * Zero imports on purpose: the shared send path loads this with the gate.
 */

export type InfrastructureFaultCode =
  | "db_unavailable"
  | "db_transaction"
  | "import_failed"
  | "bridge_timeout"
  | "cipher_locked"
  | "sidecar_unanswered"
  /** The surface breaker is open; explicit work reports it rather than running. */
  | "breaker_tripped"
  | "internal"

export class RouterFusionInfrastructureError extends Error {
  readonly kind = "router_fusion_infrastructure"
  constructor(
    readonly code: InfrastructureFaultCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "RouterFusionInfrastructureError"
  }
}

/** A refusal the spec requires — never a fault, never bypassed. */
export class RouterFusionRefusalError extends Error {
  readonly kind = "router_fusion_refusal"
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = "RouterFusionRefusalError"
  }
}

/**
 * Explicitly chosen fusion work (cascade/panel/delegate, the Run API, `cognia/*`
 * virtual models) that could not run because the infrastructure failed. It is
 * surfaced as-is: such work is never faked with an ordinary answer.
 */
export class RouterFusionUnavailableError extends Error {
  readonly kind = "router_fusion_unavailable"
  readonly code = "ROUTER_FUSION_UNAVAILABLE"
  constructor(
    readonly fault: RouterFusionInfrastructureError,
    message = `Router + Fusion is unavailable (${fault.code}).`
  ) {
    super(message)
    this.name = "RouterFusionUnavailableError"
  }
}

/** Dexie / IndexedDB failure names that mean the store itself is unusable. */
const DB_OPEN_ERRORS = new Set([
  "OpenFailedError",
  "DatabaseClosedError",
  "MissingAPIError",
  "VersionError",
  "InvalidStateError",
  "UpgradeError",
  "QuotaExceededError",
])
const DB_TRANSACTION_ERRORS = new Set([
  "AbortError",
  "TransactionInactiveError",
  "PrematureCommitError",
  "ReadOnlyError",
  "UnknownError",
  "DataCloneError",
  "InvalidAccessError",
  "TimeoutError",
])

function errorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const name = (error as { name?: unknown }).name
  return typeof name === "string" ? name : undefined
}

/**
 * Classify anything thrown by fusion code. Refusals come back as `null`; every
 * other throw becomes an infrastructure fault — an unexpected exception in the
 * ledger is exactly the "internal exception" D38 names, not a reason to crash
 * an ordinary chat.
 */
export function toInfrastructureFault(error: unknown): RouterFusionInfrastructureError | null {
  if (error instanceof RouterFusionRefusalError) return null
  if (error instanceof RouterFusionInfrastructureError) return error
  if (error instanceof RouterFusionUnavailableError) return error.fault
  const name = errorName(error)
  const message = error instanceof Error ? error.message : String(error)
  if (name && DB_OPEN_ERRORS.has(name)) {
    return new RouterFusionInfrastructureError("db_unavailable", message, error)
  }
  if (name && DB_TRANSACTION_ERRORS.has(name)) {
    return new RouterFusionInfrastructureError("db_transaction", message, error)
  }
  return new RouterFusionInfrastructureError("internal", message, error)
}

export function isRefusal(error: unknown): error is RouterFusionRefusalError {
  return error instanceof RouterFusionRefusalError
}
