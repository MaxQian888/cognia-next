/** Limits both sides enforce (protocol §4–5). */

export const MAX_ACTIVE_DEVICES = 32
/** JCS bytes of one registry element, signatures included. */
export const MAX_ENTRY_BYTES = 8192
/** At most this many entries in one atomic append. */
export const MAX_BATCH_ENTRIES = 2
export const REQUEST_TTL_MS = 15 * 60 * 1000
export const MAX_PENDING_REQUESTS = 3
export const MAX_REQUESTS_PER_HOUR = 10
export const PROOF_MAX_SKEW_MS = 120 * 1000
export const MAX_DEVICE_NAME_BYTES = 64
/** A device's display name, sealed to one approver, as base64url text. */
export const MAX_SEALED_NAME_CHARS = 512
