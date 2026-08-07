const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true })

export const RTC_MAX_FRAME_BYTES = 32 * 1024
export const RTC_MAX_MESSAGE_BYTES = 1024 * 1024
export const RTC_MAX_REASSEMBLIES = 8
export const RTC_MAX_REASSEMBLY_BYTES = 4 * 1024 * 1024
export const RTC_CHUNK_TIMEOUT_MS = 15_000
const CHUNK_DATA_BYTES = 23 * 1024
const BINARY_RESOURCE_MAGIC = new Uint8Array([0x43, 0x47, 0x4d, 0x31])
const BINARY_RESOURCE_ID_BYTES = 36
export const RTC_BINARY_RESOURCE_HEADER_BYTES =
  BINARY_RESOURCE_MAGIC.byteLength + BINARY_RESOURCE_ID_BYTES + 4 + 4

export interface RtcBinaryResourceChunk {
  requestId: string
  index: number
  totalChunks: number
  bytes: Uint8Array
}

export function decodeRtcBinaryResourceChunk(data: ArrayBuffer): RtcBinaryResourceChunk {
  const bytes = new Uint8Array(data)
  if (
    bytes.byteLength < RTC_BINARY_RESOURCE_HEADER_BYTES ||
    bytes.byteLength > RTC_MAX_FRAME_BYTES ||
    !BINARY_RESOURCE_MAGIC.every((value, index) => bytes[index] === value)
  ) {
    throw new Error("invalid_binary_resource_frame")
  }
  const requestId = TEXT_DECODER.decode(
    bytes.slice(
      BINARY_RESOURCE_MAGIC.byteLength,
      BINARY_RESOURCE_MAGIC.byteLength + BINARY_RESOURCE_ID_BYTES
    )
  )
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)
  ) {
    throw new Error("invalid_binary_resource_frame")
  }
  const view = new DataView(data)
  const index = view.getUint32(BINARY_RESOURCE_MAGIC.byteLength + BINARY_RESOURCE_ID_BYTES)
  const totalChunks = view.getUint32(
    BINARY_RESOURCE_MAGIC.byteLength + BINARY_RESOURCE_ID_BYTES + 4
  )
  if (totalChunks < 1 || index >= totalChunks) {
    throw new Error("invalid_binary_resource_frame")
  }
  return {
    requestId,
    index,
    totalChunks,
    bytes: bytes.slice(RTC_BINARY_RESOURCE_HEADER_BYTES),
  }
}

type ChunkFrame =
  | {
      kind: "chunk/start"
      messageId: string
      totalBytes: number
      totalChunks: number
    }
  | { kind: "chunk/data"; messageId: string; index: number; data: string }
  | { kind: "chunk/ack"; messageId: string }
  | { kind: "chunk/cancel"; messageId: string; reason: string }

export type ReassemblyResult =
  | { kind: "message"; bytes: Uint8Array; messageId?: string }
  | { kind: "ack"; messageId: string }
  | { kind: "cancel"; messageId: string; reason: string }
  | { kind: "partial" }

interface PendingMessage {
  totalBytes: number
  totalChunks: number
  chunks: Map<number, Uint8Array>
  receivedBytes: number
  expiresAt: number
}

export function encodeRtcLogicalMessage(text: string, messageId = crypto.randomUUID()): string[] {
  const bytes = TEXT_ENCODER.encode(text)
  if (bytes.byteLength > RTC_MAX_MESSAGE_BYTES) {
    throw new Error("rtc_message_too_large")
  }
  if (bytes.byteLength <= RTC_MAX_FRAME_BYTES) return [text]

  const totalChunks = Math.ceil(bytes.byteLength / CHUNK_DATA_BYTES)
  const frames = [
    JSON.stringify({
      kind: "chunk/start",
      messageId,
      totalBytes: bytes.byteLength,
      totalChunks,
    } satisfies ChunkFrame),
  ]
  for (let index = 0; index < totalChunks; index++) {
    const chunk = bytes.slice(index * CHUNK_DATA_BYTES, (index + 1) * CHUNK_DATA_BYTES)
    frames.push(
      JSON.stringify({
        kind: "chunk/data",
        messageId,
        index,
        data: bytesToBase64Url(chunk),
      } satisfies ChunkFrame)
    )
  }
  if (frames.some((frame) => TEXT_ENCODER.encode(frame).byteLength > RTC_MAX_FRAME_BYTES)) {
    throw new Error("rtc_chunk_frame_too_large")
  }
  return frames
}

export function encodeRtcChunkAck(messageId: string): string {
  return JSON.stringify({ kind: "chunk/ack", messageId } satisfies ChunkFrame)
}

export function encodeRtcChunkCancel(messageId: string, reason: string): string {
  return JSON.stringify({ kind: "chunk/cancel", messageId, reason } satisfies ChunkFrame)
}

export class RtcChunkReassembler {
  private readonly pending = new Map<string, PendingMessage>()
  private reservedBytes = 0

  accept(raw: string, nowMs = Date.now()): ReassemblyResult {
    this.expire(nowMs)
    if (TEXT_ENCODER.encode(raw).byteLength > RTC_MAX_FRAME_BYTES) {
      return { kind: "cancel", messageId: "", reason: "frame_too_large" }
    }
    const frame = parseChunkFrame(raw)
    if (!frame) return { kind: "message", bytes: TEXT_ENCODER.encode(raw) }
    if (frame.kind === "chunk/ack") return { kind: "ack", messageId: frame.messageId }
    if (frame.kind === "chunk/cancel") {
      this.remove(frame.messageId)
      return { kind: "cancel", messageId: frame.messageId, reason: frame.reason }
    }
    if (frame.kind === "chunk/start") {
      if (
        !frame.messageId ||
        !Number.isSafeInteger(frame.totalBytes) ||
        frame.totalBytes < 1 ||
        frame.totalBytes > RTC_MAX_MESSAGE_BYTES ||
        !Number.isSafeInteger(frame.totalChunks) ||
        frame.totalChunks < 1
      ) {
        return { kind: "cancel", messageId: frame.messageId, reason: "invalid_start" }
      }
      if (this.pending.has(frame.messageId)) {
        return { kind: "cancel", messageId: frame.messageId, reason: "duplicate_start" }
      }
      if (
        this.pending.size >= RTC_MAX_REASSEMBLIES ||
        this.reservedBytes + frame.totalBytes > RTC_MAX_REASSEMBLY_BYTES
      ) {
        return { kind: "cancel", messageId: frame.messageId, reason: "reassembly_overflow" }
      }
      this.pending.set(frame.messageId, {
        totalBytes: frame.totalBytes,
        totalChunks: frame.totalChunks,
        chunks: new Map(),
        receivedBytes: 0,
        expiresAt: nowMs + RTC_CHUNK_TIMEOUT_MS,
      })
      this.reservedBytes += frame.totalBytes
      return { kind: "partial" }
    }

    const pending = this.pending.get(frame.messageId)
    if (
      !pending ||
      !Number.isSafeInteger(frame.index) ||
      frame.index < 0 ||
      frame.index >= pending.totalChunks
    ) {
      return { kind: "cancel", messageId: frame.messageId, reason: "invalid_chunk" }
    }
    if (pending.chunks.has(frame.index)) return { kind: "partial" }
    let chunk: Uint8Array
    try {
      chunk = base64UrlToBytes(frame.data)
    } catch {
      this.remove(frame.messageId)
      return { kind: "cancel", messageId: frame.messageId, reason: "invalid_chunk" }
    }
    pending.chunks.set(frame.index, chunk)
    pending.receivedBytes += chunk.byteLength
    if (pending.receivedBytes > pending.totalBytes) {
      this.remove(frame.messageId)
      return { kind: "cancel", messageId: frame.messageId, reason: "length_mismatch" }
    }
    if (pending.chunks.size !== pending.totalChunks) return { kind: "partial" }

    const output = new Uint8Array(pending.totalBytes)
    let offset = 0
    for (let index = 0; index < pending.totalChunks; index++) {
      const part = pending.chunks.get(index)
      if (!part || offset + part.byteLength > output.byteLength) {
        this.remove(frame.messageId)
        return { kind: "cancel", messageId: frame.messageId, reason: "length_mismatch" }
      }
      output.set(part, offset)
      offset += part.byteLength
    }
    this.remove(frame.messageId)
    if (offset !== output.byteLength) {
      return { kind: "cancel", messageId: frame.messageId, reason: "length_mismatch" }
    }
    return { kind: "message", bytes: output, messageId: frame.messageId }
  }

  decode(result: Extract<ReassemblyResult, { kind: "message" }>): string {
    return TEXT_DECODER.decode(result.bytes)
  }

  private expire(nowMs: number): void {
    for (const [messageId, pending] of this.pending) {
      if (pending.expiresAt <= nowMs) this.remove(messageId)
    }
  }

  private remove(messageId: string): void {
    const pending = this.pending.get(messageId)
    if (!pending) return
    this.reservedBytes -= pending.totalBytes
    this.pending.delete(messageId)
  }
}

function parseChunkFrame(raw: string): ChunkFrame | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== "object") return null
  const kind = (value as { kind?: unknown }).kind
  if (!["chunk/start", "chunk/data", "chunk/ack", "chunk/cancel"].includes(String(kind))) {
    return null
  }
  return value as ChunkFrame
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error("invalid base64url")
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=")
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
