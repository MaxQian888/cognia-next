/** Error codes on the wire (protocol §16) and the registry's own failures. */

export type SyncErrorCode =
  | "unauthorized"
  | "device_revoked"
  | "device_pending"
  | "device_unknown"
  | "space_exists"
  | "space_empty"
  | "head_moved"
  | "invalid_entry"
  | "envelopes_incomplete"
  | "request_unknown"
  | "request_state"
  | "request_expired"
  | "too_many_requests"
  | "clock_skew"
  | "bad_proof"
  | "bad_request"
  | "client_too_old"
  | "seq_gap"
  | "epoch_stale"
  | "quota_readonly"
  | "bad_ticket"

/** Why a registry (or one appended entry) was refused. */
export type RegistryErrorCode =
  | "malformed"
  | "bad_signature"
  | "bad_link"
  | "bad_genesis"
  | "rule"
  | "incomplete_batch"
  | "rollback"
  | "fork"

export class RegistryError extends Error {
  readonly code: RegistryErrorCode

  constructor(code: RegistryErrorCode, message: string) {
    super(message)
    this.name = "RegistryError"
    this.code = code
  }
}
