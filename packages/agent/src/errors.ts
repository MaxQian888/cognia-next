import { RPC_ERROR_CODES } from "./rpc/protocol"

/**
 * Every error this SDK throws carries a stable string `code`.
 *
 * Numeric JSON-RPC codes stay on the wire and remain reachable as
 * `RpcError.rpcCode`, but callers branch on the string: the numbers are a
 * transport detail, and several conditions the SDK reports (a lost connection,
 * a command whose outcome is unknown, a saturated subscriber) never travel over
 * the wire at all and therefore have no number to branch on.
 */
export type CogniaErrorCode =
  // Wire codes, one per RPC_ERROR_CODES entry.
  | "parse_error"
  | "invalid_request"
  | "method_not_found"
  | "invalid_params"
  | "internal_error"
  | "protocol_error"
  | "session_busy"
  | "session_not_found"
  | "session_locked"
  | "config_error"
  | "permission_denied"
  | "capability_error"
  | "cancelled"
  | "timeout"
  | "host_not_found"
  | "incompatible_host"
  | "backpressure_exceeded"
  | "recovery_required"
  | "callback_failed"
  | "limit_exceeded"
  | "version_conflict"
  | "schema_mismatch"
  | "handler_unavailable"
  | "output_invalid"
  | "asset_not_found"
  // Client-only conditions with no wire representation.
  | "indeterminate_command"
  | "connection_lost"
  | "reconnect_failed"

/** Numeric wire code -> stable string code. */
const CODE_BY_NUMBER = new Map<number, CogniaErrorCode>([
  [RPC_ERROR_CODES.parseError, "parse_error"],
  [RPC_ERROR_CODES.invalidRequest, "invalid_request"],
  [RPC_ERROR_CODES.methodNotFound, "method_not_found"],
  [RPC_ERROR_CODES.invalidParams, "invalid_params"],
  [RPC_ERROR_CODES.internalError, "internal_error"],
  [RPC_ERROR_CODES.protocolError, "protocol_error"],
  [RPC_ERROR_CODES.sessionBusy, "session_busy"],
  [RPC_ERROR_CODES.sessionNotFound, "session_not_found"],
  [RPC_ERROR_CODES.sessionLocked, "session_locked"],
  [RPC_ERROR_CODES.configError, "config_error"],
  [RPC_ERROR_CODES.permissionDenied, "permission_denied"],
  [RPC_ERROR_CODES.capabilityError, "capability_error"],
  [RPC_ERROR_CODES.cancelled, "cancelled"],
  [RPC_ERROR_CODES.timeout, "timeout"],
  [RPC_ERROR_CODES.hostNotFound, "host_not_found"],
  [RPC_ERROR_CODES.incompatibleHost, "incompatible_host"],
  [RPC_ERROR_CODES.backpressureExceeded, "backpressure_exceeded"],
  [RPC_ERROR_CODES.recoveryRequired, "recovery_required"],
  [RPC_ERROR_CODES.callbackFailed, "callback_failed"],
  [RPC_ERROR_CODES.limitExceeded, "limit_exceeded"],
  [RPC_ERROR_CODES.versionConflict, "version_conflict"],
  [RPC_ERROR_CODES.schemaMismatch, "schema_mismatch"],
  [RPC_ERROR_CODES.handlerUnavailable, "handler_unavailable"],
  [RPC_ERROR_CODES.outputInvalid, "output_invalid"],
  [RPC_ERROR_CODES.assetNotFound, "asset_not_found"],
])

/** Unknown numeric codes degrade to `internal_error` rather than throwing. */
export function stringCodeForRpcCode(rpcCode: number): CogniaErrorCode {
  return CODE_BY_NUMBER.get(rpcCode) ?? "internal_error"
}

export abstract class CogniaError extends Error {
  abstract readonly code: CogniaErrorCode

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** A failure the host reported over JSON-RPC. */
export class RpcError extends CogniaError {
  readonly code: CogniaErrorCode
  /** The numeric JSON-RPC code exactly as it arrived. */
  readonly rpcCode: number
  readonly data?: unknown

  constructor(rpcCode: number, message: string, data?: unknown) {
    super(message)
    this.name = "RpcError"
    this.rpcCode = rpcCode
    this.code = stringCodeForRpcCode(rpcCode)
    this.data = data
  }
}

export class HostNotFoundError extends CogniaError {
  readonly code = "host_not_found" as const
  readonly searchedLocations: readonly string[]

  constructor(searchedLocations: readonly string[]) {
    super(`Cognia agent host not found; searched: ${searchedLocations.join(", ")}`)
    this.name = "HostNotFoundError"
    this.searchedLocations = searchedLocations
  }
}

export class IncompatibleHostError extends CogniaError {
  readonly code = "incompatible_host" as const
  readonly hostProtocolVersion: number
  readonly supportedProtocolVersions: readonly number[]

  constructor(hostProtocolVersion: number, supportedProtocolVersions: readonly number[]) {
    super(
      `host selected protocol v${hostProtocolVersion}; this SDK supports ` +
        supportedProtocolVersions.map((version) => `v${version}`).join(", ")
    )
    this.name = "IncompatibleHostError"
    this.hostProtocolVersion = hostProtocolVersion
    this.supportedProtocolVersions = supportedProtocolVersions
  }
}

/**
 * A subscriber fell far enough behind that its bounded queue overflowed.
 *
 * Only that subscriber is closed. `lastEventId` is the newest event it actually
 * received, so the caller can resume deliberately with
 * `events({ afterEventId: error.lastEventId })` and know exactly what it is
 * asking the host to replay.
 */
export class BackpressureError extends CogniaError {
  readonly code = "backpressure_exceeded" as const
  readonly lastEventId?: string
  readonly capacity: number
  readonly droppedCount: number

  constructor(options: { lastEventId?: string; capacity: number; droppedCount: number }) {
    super(
      `event subscriber overflowed its ${options.capacity}-event queue after dropping ` +
        `${options.droppedCount} event(s); resume from ${options.lastEventId ?? "the beginning"}`
    )
    this.name = "BackpressureError"
    if (options.lastEventId !== undefined) this.lastEventId = options.lastEventId
    this.capacity = options.capacity
    this.droppedCount = options.droppedCount
  }
}

/**
 * A command was written to the host but its result never came back.
 *
 * The SDK does not know whether the host executed it, so it does not resend it.
 * Re-issuing the *same* `commandId` is safe: the host's receipt table returns
 * the original result for a duplicate command rather than running it twice.
 */
export class IndeterminateCommandError extends CogniaError {
  readonly code = "indeterminate_command" as const
  readonly commandId: string
  readonly method: string
  readonly sessionId?: string

  constructor(options: { commandId: string; method: string; sessionId?: string; cause?: unknown }) {
    super(
      `the outcome of ${options.method} (command ${options.commandId}) is unknown; ` +
        "the connection dropped before the host answered. Retry with the same commandId " +
        "to reuse the host receipt, or query the session state."
    )
    this.name = "IndeterminateCommandError"
    this.commandId = options.commandId
    this.method = options.method
    if (options.sessionId !== undefined) this.sessionId = options.sessionId
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** The transport dropped and no reconnect was configured or possible. */
export class ConnectionLostError extends CogniaError {
  readonly code = "connection_lost" as const

  constructor(message = "the connection to the Cognia host was lost") {
    super(message)
    this.name = "ConnectionLostError"
  }
}

/** Reconnection was attempted and exhausted its budget. */
export class ReconnectFailedError extends CogniaError {
  readonly code = "reconnect_failed" as const
  readonly attempts: number

  constructor(attempts: number, cause?: unknown) {
    super(`reconnecting to the Cognia host failed after ${attempts} attempt(s)`)
    this.name = "ReconnectFailedError"
    this.attempts = attempts
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * A negotiated protocol limit would be exceeded by this call.
 *
 * Raised client-side before the frame is written so the caller sees which limit
 * it hit, instead of an opaque host-side rejection or a killed connection.
 */
export class ProtocolLimitError extends CogniaError {
  readonly code = "limit_exceeded" as const
  readonly limit: string
  readonly allowed: number
  readonly requested: number

  constructor(limit: string, allowed: number, requested: number) {
    super(`${limit} limit exceeded: requested ${requested}, host allows ${allowed}`)
    this.name = "ProtocolLimitError"
    this.limit = limit
    this.allowed = allowed
    this.requested = requested
  }
}
