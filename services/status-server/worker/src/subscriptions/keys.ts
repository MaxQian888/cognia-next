/**
 * Subscriber address protection: an HMAC lookup index and AES-GCM
 * encryption at rest, both keyed by Worker secrets with explicit key IDs.
 *
 * Rotation (documented for operators):
 * 1. Add the new key under a new ID to `SUBSCRIBER_HMAC_KEYS` /
 *    `SUBSCRIBER_ENC_KEYS` and point `SUBSCRIBER_HMAC_KEY_ID` /
 *    `SUBSCRIBER_ENC_KEY_ID` at it. Keep the old keys in the JSON.
 * 2. Lookups try the current HMAC key first, then every older one, so an
 *    address indexed under an old key is still found; a row touched by a
 *    signup is re-indexed and re-encrypted under the current keys, and
 *    retention re-keys a bounded batch of the remaining rows every run.
 * 3. When no row records an old key ID any more (suppressed rows purged to
 *    their HMAC can only be re-indexed while their ciphertext exists, so
 *    wait out their 30-day purge), remove the old key from the JSON.
 * Secrets are never logged; only key IDs are stored with each row.
 */

import { base64UrlToBytes, bytesToBase64Url, bytesToHex } from "../../../../../lib/status/signing"
import type { Env } from "../env"

export const MIN_HMAC_KEY_BYTES = 32
export const ENC_KEY_BYTES = 32
const IV_BYTES = 12

export interface KeyRing {
  currentId: string
  /** Current key first, then the others in a stable order. */
  keys: Array<{ id: string; bytes: Uint8Array }>
}

function parseKeyJson(
  raw: string | undefined,
  minBytes: number,
  exactBytes?: number
): Map<string, Uint8Array> | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const keys = new Map<string, Uint8Array>()
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(id)) return null
    const bytes = base64UrlToBytes(value)
    if (!bytes || bytes.byteLength < minBytes) return null
    if (exactBytes !== undefined && bytes.byteLength !== exactBytes) return null
    keys.set(id, bytes)
  }
  return keys
}

function ring(
  raw: string | undefined,
  currentId: string | undefined,
  minBytes: number,
  exactBytes?: number
): KeyRing | null {
  const keys = parseKeyJson(raw, minBytes, exactBytes)
  const id = currentId?.trim()
  if (!keys || !id) return null
  const current = keys.get(id)
  if (!current) return null
  const others = [...keys.entries()]
    .filter(([keyId]) => keyId !== id)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([keyId, bytes]) => ({ id: keyId, bytes }))
  return { currentId: id, keys: [{ id, bytes: current }, ...others] }
}

export function hmacKeyRing(env: Env): KeyRing | null {
  return ring(env.SUBSCRIBER_HMAC_KEYS, env.SUBSCRIBER_HMAC_KEY_ID, MIN_HMAC_KEY_BYTES)
}

export function encKeyRing(env: Env): KeyRing | null {
  return ring(env.SUBSCRIBER_ENC_KEYS, env.SUBSCRIBER_ENC_KEY_ID, ENC_KEY_BYTES, ENC_KEY_BYTES)
}

/** Both rings parse and name a present current key. */
export function subscriberKeysConfigured(env: Env): boolean {
  return hmacKeyRing(env) !== null && encKeyRing(env) !== null
}

function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  copy.set(bytes)
  return copy
}

async function hmacHex(keyBytes: Uint8Array, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    buffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign("HMAC", key, buffer(new TextEncoder().encode(message)))
  return bytesToHex(new Uint8Array(signature))
}

/** Domain-separated so the index can never collide with another HMAC use. */
function indexMessage(normalizedEmail: string): string {
  return `cognia-status-subscriber-v1\n${normalizedEmail}`
}

/** The address's index under every configured key, current first. */
export async function emailHmacs(
  hmacRing: KeyRing,
  normalizedEmail: string
): Promise<Array<{ keyId: string; hmac: string }>> {
  return Promise.all(
    hmacRing.keys.map(async (key) => ({
      keyId: key.id,
      hmac: await hmacHex(key.bytes, indexMessage(normalizedEmail)),
    }))
  )
}

/** HMAC of an arbitrary value with a secret string (IP rate buckets). */
export async function hmacWithSecret(secret: string, value: string): Promise<string> {
  return hmacHex(new TextEncoder().encode(secret), value)
}

async function aesKey(bytes: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buffer(bytes), { name: "AES-GCM" }, false, [usage])
}

/** The subscriber ID is authenticated data, so a ciphertext cannot be moved to another row. */
function aad(subscriberId: string): Uint8Array<ArrayBuffer> {
  return buffer(new TextEncoder().encode(`cognia-status-subscriber:${subscriberId}`))
}

export async function encryptEmail(
  encRing: KeyRing,
  subscriberId: string,
  normalizedEmail: string
): Promise<{ keyId: string; ciphertext: string }> {
  const current = encRing.keys[0]
  if (!current) throw new Error("no current encryption key")
  const iv = new Uint8Array(IV_BYTES)
  crypto.getRandomValues(iv)
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buffer(iv), additionalData: aad(subscriberId) },
    await aesKey(current.bytes, "encrypt"),
    buffer(new TextEncoder().encode(normalizedEmail))
  )
  const out = new Uint8Array(IV_BYTES + sealed.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(sealed), IV_BYTES)
  return { keyId: current.id, ciphertext: bytesToBase64Url(out) }
}

/** Null when the key is gone or the ciphertext does not authenticate. */
export async function decryptEmail(
  encRing: KeyRing,
  subscriberId: string,
  keyId: string,
  ciphertext: string
): Promise<string | null> {
  const key = encRing.keys.find((candidate) => candidate.id === keyId)
  const bytes = base64UrlToBytes(ciphertext)
  if (!key || !bytes || bytes.byteLength <= IV_BYTES) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buffer(bytes.slice(0, IV_BYTES)), additionalData: aad(subscriberId) },
      await aesKey(key.bytes, "decrypt"),
      buffer(bytes.slice(IV_BYTES))
    )
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain)
  } catch {
    return null
  }
}
