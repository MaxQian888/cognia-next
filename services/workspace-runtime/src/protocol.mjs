export const PRIVATE_PROTOCOL_VERSION = 1
export const FRAME_HEADER_BYTES = 24
const JPEG_CODEC = 1

export function protocolEnvelope(type, payload, requestId) {
  return {
    version: PRIVATE_PROTOCOL_VERSION,
    type,
    ...(requestId ? { requestId } : {}),
    payload,
  }
}

export function encodeMediaFrame({ sequence, width, height, timestamp, jpeg }) {
  const payload = Buffer.from(jpeg)
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length)
  frame.writeUInt8(PRIVATE_PROTOCOL_VERSION, 0)
  frame.writeUInt8(JPEG_CODEC, 1)
  frame.writeUInt16BE(FRAME_HEADER_BYTES, 2)
  frame.writeUInt32BE(sequence, 4)
  frame.writeUInt16BE(width, 8)
  frame.writeUInt16BE(height, 10)
  frame.writeBigUInt64BE(BigInt(timestamp), 12)
  frame.writeUInt32BE(payload.length, 20)
  payload.copy(frame, FRAME_HEADER_BYTES)
  return frame
}

export function decodeMediaFrame(frame) {
  const bytes = Buffer.from(frame)
  if (bytes.length < FRAME_HEADER_BYTES) throw new Error("media frame header is truncated")
  const version = bytes.readUInt8(0)
  const codec = bytes.readUInt8(1)
  const headerBytes = bytes.readUInt16BE(2)
  const payloadBytes = bytes.readUInt32BE(20)
  if (version !== PRIVATE_PROTOCOL_VERSION) throw new Error("unsupported media protocol version")
  if (codec !== JPEG_CODEC) throw new Error("unsupported media codec")
  if (headerBytes !== FRAME_HEADER_BYTES || bytes.length !== headerBytes + payloadBytes) {
    throw new Error("invalid media frame length")
  }
  return {
    version,
    codec: "jpeg",
    sequence: bytes.readUInt32BE(4),
    width: bytes.readUInt16BE(8),
    height: bytes.readUInt16BE(10),
    timestamp: Number(bytes.readBigUInt64BE(12)),
    jpeg: bytes.subarray(headerBytes),
  }
}
