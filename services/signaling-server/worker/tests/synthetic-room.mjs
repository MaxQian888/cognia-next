// Canonical synthetic-room helpers for the signaling protocol (version 2).
//
// One implementation shared by the black-box integration smoke
// (`integration.mjs`) and the public status probes
// (`services/status-server/probe`, bundled into both a Node runner and the
// Cloudflare status Worker). It must therefore stay portable: only
// `globalThis.crypto` (WebCrypto), `TextEncoder`, `Uint8Array` and
// `btoa` / `atob`. No `Buffer`, no `node:crypto`, no DOM.
//
// The byte layout mirrors `services/signaling-server/core/src/protocol.rs`:
// every canonical field is a big-endian u32 length followed by its UTF-8
// bytes, and binary values travel as base64url without padding. Changing it
// breaks admission on every deployed relay.

export const PROTOCOL_VERSION = 2

/** Default descriptor lifetime used by the integration smoke. */
export const DEFAULT_ROOM_TTL_MS = 60_000

const encoder = new TextEncoder()

function subtle() {
  const api = globalThis.crypto?.subtle
  if (!api) throw new Error("WebCrypto (globalThis.crypto.subtle) is unavailable")
  return api
}

/** Base64url without padding, matching Rust's `URL_SAFE_NO_PAD`. */
export function bytesToBase64Url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  // Chunked so a large buffer cannot overflow `String.fromCharCode`'s
  // argument limit.
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000))
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Inverse of `bytesToBase64Url`; null for anything that is not base64url. */
export function base64UrlToBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) return null
  if (value.length % 4 === 1) return null
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** `length` cryptographically random bytes as base64url. */
export function randomBase64Url(length) {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

/**
 * Length-prefixed canonical encoding: for each field, `u32be(len) || utf8`.
 * Fields are stringified first, exactly like the original Buffer version.
 */
export function encodeFields(fields) {
  const encoded = fields.map((value) => encoder.encode(String(value)))
  const total = encoded.reduce((sum, field) => sum + 4 + field.byteLength, 0)
  const output = new Uint8Array(total)
  const view = new DataView(output.buffer)
  let offset = 0
  for (const field of encoded) {
    view.setUint32(offset, field.byteLength, false)
    offset += 4
    output.set(field, offset)
    offset += field.byteLength
  }
  return output
}

/** A fresh, throwaway P-256 signing identity for one role of one room. */
export async function identity() {
  const pair = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])
  return {
    privateKey: pair.privateKey,
    publicKey: bytesToBase64Url(new Uint8Array(await subtle().exportKey("raw", pair.publicKey))),
  }
}

/** Canonical descriptor bytes, as `room_descriptor_bytes` in protocol.rs. */
export function descriptorBytes(descriptor) {
  return encodeFields([
    descriptor.v,
    descriptor.roomNonce,
    descriptor.desktopSigningKey,
    descriptor.mobileSigningKey,
    descriptor.notAfter,
  ])
}

/** `roomId = base64url(SHA-256(descriptor bytes))`, as `derive_room_id`. */
export async function deriveRoomId(descriptor) {
  const digest = await subtle().digest("SHA-256", descriptorBytes(descriptor))
  return bytesToBase64Url(new Uint8Array(digest))
}

/**
 * A brand-new room: fresh desktop and mobile keys, a 16-byte nonce and a
 * short expiry. Nothing here is tied to an account, an invitation or a real
 * device, so a probe can never touch user state.
 */
export async function createRoom(options = {}) {
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? DEFAULT_ROOM_TTL_MS
  const [desktop, mobile] = await Promise.all([identity(), identity()])
  const descriptor = {
    v: PROTOCOL_VERSION,
    roomId: "",
    roomNonce: randomBase64Url(16),
    desktopSigningKey: desktop.publicKey,
    mobileSigningKey: mobile.publicKey,
    notAfter: now + ttlMs,
  }
  descriptor.roomId = await deriveRoomId(descriptor)
  return {
    descriptor: {
      v: descriptor.v,
      roomId: descriptor.roomId,
      roomNonce: descriptor.roomNonce,
      desktopSigningKey: descriptor.desktopSigningKey,
      mobileSigningKey: descriptor.mobileSigningKey,
      notAfter: descriptor.notAfter,
    },
    desktop,
    mobile,
  }
}

/** Canonical proof bytes, as `subscribe_proof_bytes` in protocol.rs. */
export function proofBytes(proof) {
  return encodeFields([
    proof.v,
    proof.roomId,
    proof.role,
    proof.sessionId,
    proof.epoch,
    proof.issuedAt,
    proof.challenge,
    proof.ecdhPublicKey,
  ])
}

/**
 * The `subscribe` frame for `role`, bound to the socket's `challenge` and
 * signed with that role's room key. Each call mints a fresh session, epoch
 * and ECDH key, like a real peer reconnecting.
 */
export async function subscribeFrame(room, role, challenge, options = {}) {
  const ecdh = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])
  const proof = {
    v: PROTOCOL_VERSION,
    roomId: room.descriptor.roomId,
    role,
    sessionId: randomBase64Url(16),
    epoch: randomBase64Url(16),
    issuedAt: options.now ?? Date.now(),
    challenge,
    ecdhPublicKey: bytesToBase64Url(
      new Uint8Array(await subtle().exportKey("raw", ecdh.publicKey))
    ),
  }
  const signature = await subtle().sign(
    { name: "ECDSA", hash: "SHA-256" },
    room[role].privateKey,
    proofBytes(proof)
  )
  return {
    kind: "subscribe",
    descriptor: room.descriptor,
    proof: { ...proof, signature: bytesToBase64Url(new Uint8Array(signature)) },
  }
}

/**
 * Verify a proof against its descriptor the way the relay does (signature
 * and room binding only; freshness and challenge are the relay's to judge).
 */
export async function verifyProof(descriptor, proof) {
  if (proof?.roomId !== descriptor.roomId) return false
  if ((await deriveRoomId(descriptor)) !== descriptor.roomId) return false
  const keyText =
    proof.role === "desktop" ? descriptor.desktopSigningKey : descriptor.mobileSigningKey
  if (proof.role !== "desktop" && proof.role !== "mobile") return false
  const rawKey = base64UrlToBytes(keyText)
  const signature = base64UrlToBytes(proof.signature)
  if (!rawKey || !signature) return false
  const key = await subtle().importKey(
    "raw",
    rawKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  )
  return subtle().verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, proofBytes(proof))
}
