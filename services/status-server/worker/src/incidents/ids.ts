/**
 * Opaque identifiers, write tokens and path helpers shared by the incident,
 * maintenance, subscription, notification and admin modules.
 *
 * IDs are random (never sequential) so a public ID reveals nothing about
 * volume or ordering, and they match the contract's opaque-ID pattern.
 */

import { STATUS_API_PATH } from "../../../../../lib/status/config"
import { bytesToBase64Url, bytesToHex } from "../../../../../lib/status/signing"

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

/** `<prefix>_<32 hex chars>`, e.g. `inc_9f…`. */
export function randomId(prefix: string): string {
  return `${prefix}_${bytesToHex(randomBytes(16))}`
}

/**
 * A per-write token. The guarded UPDATE of a parent row sets it; every other
 * statement of the same D1 batch checks it, so a lost compare-and-swap (zero
 * rows) cannot append an update, an event or an operation record.
 */
export function newWriteToken(): string {
  return bytesToHex(randomBytes(16))
}

/** 32 random bytes as base64url (43 chars): subscriber tokens. */
export function randomToken(): string {
  return bytesToBase64Url(randomBytes(32))
}

/**
 * The path relative to `/api/status/v1`, or null for any other path. Route
 * handlers return null for paths they do not own.
 */
export function relativeApiPath(url: URL): string | null {
  const path = url.pathname
  if (path === STATUS_API_PATH) return "/"
  if (!path.startsWith(`${STATUS_API_PATH}/`)) return null
  return path.slice(STATUS_API_PATH.length)
}

/** Parse a JSON column written by this service; corrupt data is a hard error. */
export function parseJsonColumn<T>(value: string, column: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error(`corrupt JSON column: ${column}`)
  }
}
