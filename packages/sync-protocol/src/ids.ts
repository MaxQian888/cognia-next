/** Identifiers (protocol §2). */

import { toBase64Url, utf8, concatBytes, randomBytes } from "./bytes"
import { crockfordEncode } from "./crockford"
import { labelledHash } from "./crypto"

export const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/
export const REQUEST_ID_PATTERN = /^req_[0-9A-HJKMNP-TV-Z]{26}$/

export function newDeviceId(): string {
  return `dev_${crockfordEncode(randomBytes(16))}`
}

export function newRequestId(): string {
  return `req_${crockfordEncode(randomBytes(16))}`
}

export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value)
}

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value)
}

/**
 * The sync space of one person at one issuer: names the account object.
 * Bound to the issuer, so staging, production and a self-hosted issuer
 * never share a space even for the same subject.
 */
export async function spaceIdFor(issuer: string, subject: string): Promise<string> {
  const digest = await labelledHash(
    "space",
    concatBytes(utf8(issuer), new Uint8Array([0]), utf8(subject))
  )
  return toBase64Url(digest)
}

export const SPACE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
