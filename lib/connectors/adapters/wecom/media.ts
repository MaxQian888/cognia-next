/**
 * WeCom media helpers — inbound decryption + outbound chunked upload.
 *
 * Inbound media (image / voice / video / file) arrives as an encrypted CDN
 * URL plus a per-message `aeskey`. Decryption is AES-256-CBC with PKCS#7
 * padding and IV = the first 16 bytes of the (base64-decoded) aeskey. Done in
 * the renderer via Web Crypto so no Rust round-trip is needed.
 *
 * Outbound media is sent by uploading the bytes through the 3-step
 * `aibot_upload_media_*` frames to obtain a `media_id`, then referencing that
 * id in an `aibot_respond_msg` / `aibot_send_msg` media frame.
 */

import {
  buildMediaInitFrame,
  buildMediaChunkFrame,
  buildMediaFinishFrame,
  newReqId,
  type WeComFrameEnvelope,
} from "./protocol"

/** Decode a base64 string into raw bytes (browser + jsdom safe). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Encode raw bytes into a base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/**
 * Decrypt WeCom-encrypted media bytes. `aeskeyBase64` decodes to a 32-byte
 * AES-256 key; the IV is its first 16 bytes. Web Crypto strips the PKCS#7
 * padding automatically.
 */
export async function decryptWeComMedia(
  ciphertext: ArrayBuffer | Uint8Array,
  aeskeyBase64: string
): Promise<Uint8Array> {
  // Fresh ArrayBuffer-backed copies so the Web Crypto `BufferSource`
  // overloads accept them (Uint8Array is generic over ArrayBufferLike).
  const key = new Uint8Array(base64ToBytes(aeskeyBase64))
  if (key.length < 16) throw new Error("wecom media aeskey too short")
  const iv = key.slice(0, 16)
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, [
    "decrypt",
  ])
  const data = new Uint8Array(ciphertext)
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, data)
  return new Uint8Array(plain)
}

/**
 * Fetch an encrypted media URL and decrypt it. Best-effort: when `aeskey` is
 * absent the raw bytes are returned undecrypted (some payloads ship in the
 * clear). Throws on network / decrypt failure so the caller can degrade to a
 * URL marker.
 */
export async function fetchAndDecryptMedia(
  url: string,
  aeskeyBase64?: string
): Promise<Uint8Array> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`wecom media fetch failed: ${resp.status}`)
  const buf = await resp.arrayBuffer()
  if (!aeskeyBase64) return new Uint8Array(buf)
  return decryptWeComMedia(buf, aeskeyBase64)
}

/** Request/response RPC over the long connection (resolves the matching ack). */
export type WeComRequestFn = (
  frame: WeComFrameEnvelope,
  timeoutMs?: number
) => Promise<WeComFrameEnvelope>

/** Chunk size for the media upload (256 KiB). */
const UPLOAD_CHUNK_BYTES = 256 * 1024

function readField(env: WeComFrameEnvelope, key: string): string | undefined {
  const top = (env as Record<string, unknown>)[key]
  if (typeof top === "string") return top
  const body = env.body as Record<string, unknown> | undefined
  const inner = body?.[key]
  return typeof inner === "string" ? inner : undefined
}

/**
 * Upload media bytes via the 3-step `aibot_upload_media_*` flow and return
 * the resulting `media_id`. Throws when the platform rejects the upload or
 * omits the id. Caps at 20 MB / 100 chunks per the protocol.
 */
export async function uploadWeComMedia(
  request: WeComRequestFn,
  adapterId: string,
  bytes: Uint8Array,
  filename: string,
  mediaType: "image" | "voice" | "video" | "file"
): Promise<string> {
  if (bytes.length > 20 * 1024 * 1024) throw new Error("wecom media exceeds 20MB cap")

  const initResp = await request(
    buildMediaInitFrame(newReqId(adapterId), filename, bytes.length, mediaType)
  )
  const uploadId = readField(initResp, "upload_id")
  if (!uploadId) throw new Error("wecom media init returned no upload_id")

  let seq = 0
  for (let off = 0; off < bytes.length; off += UPLOAD_CHUNK_BYTES) {
    const chunk = bytes.slice(off, off + UPLOAD_CHUNK_BYTES)
    await request(buildMediaChunkFrame(newReqId(adapterId), uploadId, seq, bytesToBase64(chunk)))
    seq += 1
    if (seq > 100) throw new Error("wecom media exceeds 100-chunk cap")
  }

  const finResp = await request(buildMediaFinishFrame(newReqId(adapterId), uploadId))
  const mediaId = readField(finResp, "media_id")
  if (!mediaId) throw new Error("wecom media finish returned no media_id")
  return mediaId
}
