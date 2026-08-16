/**
 * Canonical terminal framing shared by local socket, LAN WebSocket, and WebRTC.
 *
 * Mirrors `crates/cognia-terminal/src/protocol.rs` by *number*, not by name —
 * `decodeTerminalFrame` throws on an unmapped discriminant, which is why the
 * Rust side holds the invariant that the host never pushes a frame kind the
 * client did not solicit. Keep both enums in lockstep.
 */

export const TERMINAL_PROTOCOL_MAGIC = "CGTH"
export const TERMINAL_FRAME_HEADER_BYTES = 35
export const TERMINAL_MAX_FRAME_PAYLOAD = 64 * 1024
export const EMPTY_SESSION_ID = "00000000-0000-0000-0000-000000000000"

export enum TerminalFrameKind {
  Hello = 1,
  List = 2,
  Spawn = 3,
  Attach = 4,
  Detach = 5,
  TakeControl = 6,
  ReleaseControl = 7,
  Resize = 8,
  Kill = 9,
  Ack = 10,
  Stdin = 11,
  Stdout = 12,
  HostSnapshot = 13,
  SessionSnapshot = 14,
  Integration = 15,
  ControllerChanged = 16,
  ReplayGap = 17,
  TransportState = 18,
  Exit = 19,
  Error = 20,
  /** Client→host: park/unpark a session's reader. Answered with `Ack`. */
  FlowControl = 21,
  /** Client→host: ask for a session's command ring and/or the host audit log. */
  HistoryQuery = 22,
  /** Host→client: answer to `HistoryQuery`. Never pushed unsolicited. */
  HistorySnapshot = 23,
  /** Client→host: read, start, or stop a session's SSH port forwards. */
  SshForwardControl = 24,
  /** Host→client: answer to `SshForwardControl`. Never pushed unsolicited. */
  SshForwardSnapshot = 25,
}

export const TerminalFrameFlag = {
  None: 0,
  AckRequired: 1 << 0,
  EndOfMessage: 1 << 1,
} as const

export type TerminalErrorCode =
  | "not_controller"
  | "permission_denied"
  | "replay_gap"
  | "resource_limit"
  | "host_offline"
  | "unpaired"
  | "unauthorized"
  | "session_not_found"
  | "invalid_request"
  | "queue_overflow"

export class TerminalProtocolError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string
  ) {
    super(message)
    this.name = "TerminalProtocolError"
  }
}

export interface TerminalFrame {
  kind: TerminalFrameKind
  flags: number
  sessionId: string
  sequence: bigint
  payload: Uint8Array
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function encodeTerminalFrame(frame: TerminalFrame): Uint8Array {
  if (frame.payload.byteLength > TERMINAL_MAX_FRAME_PAYLOAD) {
    throw new TerminalProtocolError(
      "resource_limit",
      `terminal frame payload exceeds ${TERMINAL_MAX_FRAME_PAYLOAD} bytes`
    )
  }
  const bytes = new Uint8Array(TERMINAL_FRAME_HEADER_BYTES + frame.payload.byteLength)
  bytes.set(textEncoder.encode(TERMINAL_PROTOCOL_MAGIC), 0)
  const view = new DataView(bytes.buffer)
  view.setUint8(4, frame.kind)
  view.setUint16(5, frame.flags, false)
  bytes.set(uuidToBytes(frame.sessionId), 7)
  view.setBigUint64(23, frame.sequence, false)
  view.setUint32(31, frame.payload.byteLength, false)
  bytes.set(frame.payload, TERMINAL_FRAME_HEADER_BYTES)
  return bytes
}

export function decodeTerminalFrame(input: ArrayBuffer | Uint8Array): TerminalFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength < TERMINAL_FRAME_HEADER_BYTES) {
    throw new TerminalProtocolError("invalid_request", "terminal frame header is truncated")
  }
  if (textDecoder.decode(bytes.subarray(0, 4)) !== TERMINAL_PROTOCOL_MAGIC) {
    throw new TerminalProtocolError("invalid_request", "invalid terminal host frame magic")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kind = view.getUint8(4)
  if (!isFrameKind(kind)) {
    throw new TerminalProtocolError("invalid_request", `unknown terminal frame kind ${kind}`)
  }
  const payloadLength = view.getUint32(31, false)
  if (payloadLength > TERMINAL_MAX_FRAME_PAYLOAD) {
    throw new TerminalProtocolError("resource_limit", "terminal frame payload is too large")
  }
  if (bytes.byteLength !== TERMINAL_FRAME_HEADER_BYTES + payloadLength) {
    throw new TerminalProtocolError("invalid_request", "terminal frame payload is truncated")
  }
  return {
    kind,
    flags: view.getUint16(5, false),
    sessionId: bytesToUuid(bytes.subarray(7, 23)),
    sequence: view.getBigUint64(23, false),
    payload: bytes.slice(TERMINAL_FRAME_HEADER_BYTES),
  }
}

export function makeTerminalFrame(
  kind: TerminalFrameKind,
  options: {
    sessionId?: string
    sequence?: bigint
    flags?: number
    payload?: Uint8Array
  } = {}
): TerminalFrame {
  return {
    kind,
    flags: options.flags ?? TerminalFrameFlag.EndOfMessage,
    sessionId: options.sessionId ?? EMPTY_SESSION_ID,
    sequence: options.sequence ?? BigInt(0),
    payload: options.payload ?? new Uint8Array(),
  }
}

export function makeTerminalJsonFrame(
  kind: TerminalFrameKind,
  value: unknown,
  options: { sessionId?: string; sequence?: bigint; flags?: number } = {}
): TerminalFrame {
  return makeTerminalFrame(kind, {
    ...options,
    payload: textEncoder.encode(JSON.stringify(value)),
  })
}

export function decodeTerminalJson<T>(frame: TerminalFrame): T {
  try {
    return JSON.parse(textDecoder.decode(frame.payload)) as T
  } catch {
    throw new TerminalProtocolError("invalid_request", "terminal JSON payload is invalid")
  }
}

export function splitTerminalStreamFrames(
  kind: TerminalFrameKind.Stdin | TerminalFrameKind.Stdout,
  sessionId: string,
  sequence: bigint,
  payload: Uint8Array
): TerminalFrame[] {
  if (payload.byteLength === 0) {
    return [makeTerminalFrame(kind, { sessionId, sequence })]
  }
  const frames: TerminalFrame[] = []
  for (let offset = 0; offset < payload.byteLength; offset += TERMINAL_MAX_FRAME_PAYLOAD) {
    const end = Math.min(offset + TERMINAL_MAX_FRAME_PAYLOAD, payload.byteLength)
    frames.push(
      makeTerminalFrame(kind, {
        sessionId,
        sequence,
        flags: end === payload.byteLength ? TerminalFrameFlag.EndOfMessage : TerminalFrameFlag.None,
        payload: payload.slice(offset, end),
      })
    )
  }
  return frames
}

function isFrameKind(value: number): value is TerminalFrameKind {
  // Bounded by the highest assigned discriminant, not by `Error` — the range
  // has to grow with the enum or newly added kinds decode as "unknown".
  return (
    Number.isInteger(value) &&
    value >= TerminalFrameKind.Hello &&
    value <= TerminalFrameKind.SshForwardSnapshot
  )
}

function uuidToBytes(uuid: string): Uint8Array {
  const compact = uuid.replaceAll("-", "")
  if (!/^[0-9a-fA-F]{32}$/.test(compact)) {
    throw new TerminalProtocolError("invalid_request", "terminal session id must be a UUID")
  }
  const bytes = new Uint8Array(16)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function bytesToUuid(bytes: Uint8Array): string {
  const compact = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
}
