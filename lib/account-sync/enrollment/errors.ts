/** Why an enrollment step stopped (beyond API, crypto and vault errors). */
export type EnrollmentErrorCode =
  /** The person has no space yet, or this device is not part of it. */
  | "space-empty"
  | "not-enrolled"
  /** The list this device verified now starts from another genesis. */
  | "genesis-changed"
  /** The approving entry is missing, signed by someone else, or binds another transcript. */
  | "approval-unverified"
  /** The approver's revealed nonce does not match the new device's commitment. */
  | "commit-mismatch"
  /** The list kept moving under this change; try again. */
  | "busy"

export class EnrollmentError extends Error {
  constructor(
    readonly code: EnrollmentErrorCode,
    message: string
  ) {
    super(message)
    this.name = "EnrollmentError"
  }
}
