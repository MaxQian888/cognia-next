/** Pure, versioned OMP protocol contracts; no dependency on the OMP runtime. */
export * from "./upstream/rpc-wire.generated"
import type { RpcWireCommands, RpcInbound, RpcServerFrame } from "./upstream/rpc-wire.generated"

export type OmpCommandMap = RpcWireCommands
export type OmpCommandName = keyof OmpCommandMap
export type OmpCommand<K extends OmpCommandName = OmpCommandName> = {
  [P in K]: { type: P; id?: string } & (OmpCommandMap[P]["params"] extends undefined
    ? object
    : OmpCommandMap[P]["params"])
}[K]
export type OmpOutboundFrame = OmpCommand | RpcInbound
export type OmpServerFrame = RpcServerFrame
export interface OmpChunkFrame {
  type: "rpc_chunk"
  chunkId: string
  index: number
  count: number
  byteLength: number
  data: string
}
export type OmpPhysicalFrame = OmpServerFrame | OmpChunkFrame

export const OMP_MAX_FRAME_BYTES = 1024 * 1024
export const OMP_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024

export class OmpProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OmpProtocolError"
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** V2 only chunks server output. Client input must remain one bounded JSONL frame. */
export function encodeOmpFrame(frame: OmpOutboundFrame, maxBytes = OMP_MAX_FRAME_BYTES): string {
  const line = JSON.stringify(frame) + "\n"
  if (new TextEncoder().encode(line).byteLength > maxBytes) {
    throw new OmpProtocolError(`OMP outbound frame exceeds ${maxBytes} bytes`)
  }
  return line
}

/** Strict, uninterrupted protocol-v2 chunk reassembly, adapted from OMP v18.6.1. */
export class OmpChunkDecoder {
  private pending?: {
    id: string
    count: number
    length: number
    next: number
    received: number
    chunks: Uint8Array[]
  }
  constructor(private maxBytes = OMP_MAX_REASSEMBLED_BYTES) {}
  setLimit(limit: number): void {
    this.maxBytes = Math.min(limit, OMP_MAX_REASSEMBLED_BYTES)
  }
  get incomplete(): boolean {
    return this.pending !== undefined
  }
  reset(): void {
    this.pending = undefined
  }

  push(value: unknown): Record<string, unknown> | undefined {
    try {
      return this.decode(value)
    } catch (error) {
      this.reset()
      throw error
    }
  }

  private decode(value: unknown): Record<string, unknown> | undefined {
    if (!record(value)) throw new OmpProtocolError("OMP frame must be an object")
    if (value.type !== "rpc_chunk") {
      if (this.pending) throw new OmpProtocolError("OMP chunk sequence interrupted")
      if (typeof value.type !== "string") throw new OmpProtocolError("OMP frame requires a type")
      return value
    }
    const { chunkId, index, count, byteLength, data } = value
    if (
      typeof chunkId !== "string" ||
      !chunkId.length ||
      chunkId.length > 128 ||
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 2 ||
      count > Math.ceil(OMP_MAX_REASSEMBLED_BYTES / CHUNK_BYTES) ||
      index >= count ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < OMP_MAX_FRAME_BYTES ||
      byteLength > this.maxBytes
    ) {
      throw new OmpProtocolError("Invalid OMP chunk metadata")
    }
    if (
      typeof data !== "string" ||
      !data.length ||
      data.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    ) {
      throw new OmpProtocolError("Invalid OMP chunk base64")
    }
    const binary = atob(data)
    if (btoa(binary) !== data || binary.length > CHUNK_BYTES)
      throw new OmpProtocolError("Invalid OMP chunk payload")
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    if (!this.pending) {
      if (index !== 0) throw new OmpProtocolError("OMP chunk sequence must start at index 0")
      this.pending = { id: chunkId, count, length: byteLength, next: 0, received: 0, chunks: [] }
    }
    const pending = this.pending
    if (
      pending.id !== chunkId ||
      pending.count !== count ||
      pending.length !== byteLength ||
      pending.next !== index
    ) {
      throw new OmpProtocolError("OMP chunk sequence mismatch")
    }
    pending.chunks.push(bytes)
    pending.received += bytes.byteLength
    pending.next++
    if (pending.received > pending.length)
      throw new OmpProtocolError("OMP chunk sequence exceeds declared length")
    if (pending.next < pending.count) return undefined
    if (pending.received !== pending.length)
      throw new OmpProtocolError("OMP chunk sequence length mismatch")
    const complete = new Uint8Array(pending.length)
    let offset = 0
    for (const part of pending.chunks) {
      complete.set(part, offset)
      offset += part.length
    }
    this.reset()
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(complete))
    if (!record(decoded) || typeof decoded.type !== "string" || decoded.type === "rpc_chunk") {
      throw new OmpProtocolError("Invalid OMP reassembled frame")
    }
    return decoded
  }
}
