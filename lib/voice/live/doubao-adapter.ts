import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate"
import type {
  Experimental_RealtimeModelV4 as RealtimeModel,
  Experimental_RealtimeModelV4ClientEvent as ClientEvent,
  Experimental_RealtimeModelV4ServerEvent as ServerEvent,
  Experimental_RealtimeModelV4SessionConfig as SessionConfig,
} from "@ai-sdk/provider"

export const DOUBAO_EVENTS = {
  startConnection: 1,
  connectionStarted: 50,
  connectionFailed: 51,
  startSession: 100,
  cancelSession: 101,
  sessionStarted: 150,
  sessionCanceled: 151,
  sessionFinished: 152,
  sessionFailed: 153,
  taskRequest: 200,
  audioMuted: 250,
  ttsSentenceStart: 350,
  ttsSentenceEnd: 351,
  ttsResponse: 352,
  ttsEnded: 359,
  asrInfo: 450,
  asrResponse: 451,
  asrEnded: 459,
  chatResponse: 550,
  chatEnded: 559,
} as const

const FULL_CLIENT_REQUEST = 0x1
const AUDIO_ONLY_REQUEST = 0x2
const FULL_SERVER_RESPONSE = 0x9
const AUDIO_ONLY_RESPONSE = 0xb
const ERROR_RESPONSE = 0xf
const FLAG_WITH_EVENT = 0x4
const FLAG_WITH_SESSION = 0x1
const SERIALIZATION_NONE = 0
const SERIALIZATION_JSON = 1
const COMPRESSION_NONE = 0
const COMPRESSION_GZIP = 1

export interface DoubaoFrame {
  messageType: number
  event: number
  sessionId?: string
  payload: Uint8Array | Record<string, unknown>
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

export function encodeDoubaoFrame(options: {
  messageType: number
  event: number
  sessionId?: string
  payload?: Uint8Array | Record<string, unknown>
  gzip?: boolean
}): Uint8Array {
  const isJson = !(options.payload instanceof Uint8Array)
  let payload =
    options.payload instanceof Uint8Array
      ? options.payload
      : strToU8(JSON.stringify(options.payload ?? {}))
  if (options.gzip) payload = gzipSync(payload)
  const flags = FLAG_WITH_EVENT | (options.sessionId ? FLAG_WITH_SESSION : 0)
  const header = new Uint8Array([
    0x11,
    (options.messageType << 4) | flags,
    ((isJson ? SERIALIZATION_JSON : SERIALIZATION_NONE) << 4) |
      (options.gzip ? COMPRESSION_GZIP : COMPRESSION_NONE),
    0,
  ])
  const session = options.sessionId ? strToU8(options.sessionId) : null
  return concat([
    header,
    u32(options.event),
    ...(session ? [u32(session.length), session] : []),
    u32(payload.length),
    payload,
  ])
}

export function decodeDoubaoFrame(data: Uint8Array): DoubaoFrame {
  if (data.length < 12) throw new Error("malformed Doubao frame: truncated header")
  const headerWords = data[0] & 0x0f
  if (data[0] >> 4 !== 1 || headerWords < 1) {
    throw new Error("malformed Doubao frame: unsupported version")
  }
  const headerBytes = headerWords * 4
  const messageType = data[1] >> 4
  const flags = data[1] & 0x0f
  const serialization = data[2] >> 4
  const compression = data[2] & 0x0f
  let offset = headerBytes
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const readLength = (label: string): number => {
    if (offset + 4 > data.length) throw new Error(`malformed Doubao frame: missing ${label}`)
    const value = view.getUint32(offset)
    offset += 4
    return value
  }
  const event = readLength("event")
  let sessionId: string | undefined
  if (flags & FLAG_WITH_SESSION) {
    const length = readLength("session length")
    if (offset + length > data.length) throw new Error("malformed Doubao frame: partial session id")
    sessionId = strFromU8(data.subarray(offset, offset + length))
    offset += length
  }
  const payloadLength = readLength("payload length")
  if (offset + payloadLength !== data.length) {
    throw new Error("malformed Doubao frame: partial or trailing payload")
  }
  let bytes = data.subarray(offset)
  if (compression === COMPRESSION_GZIP) {
    try {
      bytes = gunzipSync(bytes)
    } catch {
      throw new Error("malformed Doubao frame: invalid gzip payload")
    }
  } else if (compression !== COMPRESSION_NONE) {
    throw new Error("malformed Doubao frame: unsupported compression")
  }
  let payload: DoubaoFrame["payload"] = bytes
  if (serialization === SERIALIZATION_JSON) {
    try {
      payload = JSON.parse(strFromU8(bytes)) as Record<string, unknown>
    } catch {
      throw new Error("malformed Doubao frame: invalid JSON payload")
    }
  }
  return { messageType, event, ...(sessionId ? { sessionId } : {}), payload }
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function toBase64(value: Uint8Array): string {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function payloadRecord(frame: DoubaoFrame): Record<string, unknown> {
  return frame.payload instanceof Uint8Array ? {} : frame.payload
}

function textFromPayload(payload: Record<string, unknown>): string {
  for (const key of ["text", "sentence", "content", "result"]) {
    if (typeof payload[key] === "string") return payload[key]
  }
  const results = payload.results
  if (Array.isArray(results)) {
    const last = results.at(-1)
    if (last && typeof last === "object") return textFromPayload(last as Record<string, unknown>)
  }
  return ""
}

export function createDoubaoLiveAdapter(modelId: string): RealtimeModel {
  let sessionId = ""
  let pendingConfig: SessionConfig = {}
  let turnIndex = 0
  let responseId = "doubao:pending:response:0"
  let assistantItemId = "doubao:pending:assistant:0"

  const userItemId = (index = turnIndex + 1) => `doubao:${sessionId || "session"}:user:${index}`

  const buildSessionConfig = (config: SessionConfig) => ({
    asr: { audio_config: { format: "pcm", sample_rate: 16_000, channel: 1, bits: 16 } },
    tts: {
      audio_config: { format: "pcm_s16le", sample_rate: 24_000, channel: 1 },
      speaker: config.voice ?? "zh_female_vv_jupiter_bigtts",
    },
    dialog: {
      ...(config.instructions ? { system_role: config.instructions } : {}),
      extra: { strict_audit: true },
    },
  })

  const parseServerEvent = (raw: unknown): ServerEvent | ServerEvent[] => {
    if (!(raw instanceof Uint8Array))
      throw new Error("malformed Doubao event: binary frame required")
    const frame = decodeDoubaoFrame(raw)
    const payload = payloadRecord(frame)
    if (frame.sessionId) sessionId = frame.sessionId
    switch (frame.event) {
      case DOUBAO_EVENTS.sessionStarted:
        turnIndex = 0
        responseId = `doubao:${sessionId || "session"}:response:0`
        assistantItemId = `doubao:${sessionId || "session"}:assistant:0`
        // SessionStarted acknowledges the StartSession payload, so it is the
        // Doubao equivalent of OpenAI-style `session.updated` and unlocks the
        // controller's readiness gate only after configuration is accepted.
        return { type: "session-updated", raw }
      case DOUBAO_EVENTS.audioMuted:
        return { type: "speech-started", itemId: userItemId(), raw }
      case DOUBAO_EVENTS.asrInfo:
        return {
          type: textFromPayload(payload).includes("start") ? "speech-started" : "speech-stopped",
          itemId: userItemId(),
          raw,
        }
      case DOUBAO_EVENTS.asrResponse:
        return { type: "custom", rawType: "doubao.asr.delta", raw }
      case DOUBAO_EVENTS.asrEnded:
        turnIndex += 1
        responseId = `doubao:${sessionId || "session"}:response:${turnIndex}`
        assistantItemId = `doubao:${sessionId || "session"}:assistant:${turnIndex}`
        return {
          type: "input-transcription-completed",
          itemId: userItemId(turnIndex),
          transcript: textFromPayload(payload),
          raw,
        }
      case DOUBAO_EVENTS.ttsSentenceStart:
        return {
          type: "audio-transcript-delta",
          responseId,
          itemId: assistantItemId,
          delta: textFromPayload(payload),
          raw,
        }
      case DOUBAO_EVENTS.ttsSentenceEnd:
        return {
          type: "audio-transcript-done",
          responseId,
          itemId: assistantItemId,
          transcript: textFromPayload(payload) || undefined,
          raw,
        }
      case DOUBAO_EVENTS.ttsResponse:
        return {
          type: "audio-delta",
          responseId,
          itemId: assistantItemId,
          delta: toBase64(frame.payload instanceof Uint8Array ? frame.payload : new Uint8Array()),
          raw,
        }
      case DOUBAO_EVENTS.ttsEnded:
        return [
          { type: "audio-done", responseId, itemId: assistantItemId, raw },
          { type: "response-done", responseId, status: "completed", raw },
        ]
      case DOUBAO_EVENTS.chatResponse:
        return {
          type: "text-delta",
          responseId,
          itemId: assistantItemId,
          delta: textFromPayload(payload),
          raw,
        }
      case DOUBAO_EVENTS.chatEnded:
        return {
          type: "text-done",
          responseId,
          itemId: assistantItemId,
          text: textFromPayload(payload) || undefined,
          raw,
        }
      case DOUBAO_EVENTS.connectionFailed:
      case DOUBAO_EVENTS.sessionFailed:
        return {
          type: "error",
          message: textFromPayload(payload) || "Doubao realtime provider error",
          code: typeof payload.code === "string" ? payload.code : undefined,
          raw,
        }
      case DOUBAO_EVENTS.sessionCanceled:
      case DOUBAO_EVENTS.sessionFinished:
        return { type: "response-done", responseId, status: "cancelled", raw }
      default:
        if (frame.messageType === ERROR_RESPONSE) {
          return {
            type: "error",
            message: textFromPayload(payload) || "Doubao protocol error",
            raw,
          }
        }
        return { type: "custom", rawType: `doubao.${frame.event}`, raw }
    }
  }

  const serializeClientEvent = (event: ClientEvent): Uint8Array | null => {
    switch (event.type) {
      case "session-update":
        pendingConfig = event.config
        sessionId = ""
        return encodeDoubaoFrame({
          messageType: FULL_CLIENT_REQUEST,
          event: DOUBAO_EVENTS.startConnection,
        })
      case "input-audio-append":
        if (!sessionId) return null
        return encodeDoubaoFrame({
          messageType: AUDIO_ONLY_REQUEST,
          event: DOUBAO_EVENTS.taskRequest,
          sessionId,
          payload: fromBase64(event.audio),
          gzip: true,
        })
      case "input-audio-clear":
      case "response-cancel":
        return sessionId
          ? encodeDoubaoFrame({
              messageType: FULL_CLIENT_REQUEST,
              event: DOUBAO_EVENTS.cancelSession,
              sessionId,
            })
          : null
      case "input-audio-commit":
        return null
      default:
        return null
    }
  }

  return {
    specificationVersion: "v4",
    provider: "doubao",
    modelId,
    doCreateClientSecret: async () => {
      throw new Error("doubao live voice uses the host keyring connection")
    },
    getWebSocketConfig: ({ url }) => ({ url }),
    buildSessionConfig,
    serializeClientEvent,
    parseServerEvent,
    getHealthCheckResponse: (raw) => {
      if (!(raw instanceof Uint8Array)) return null
      const frame = decodeDoubaoFrame(raw)
      if (frame.event !== DOUBAO_EVENTS.connectionStarted) return null
      sessionId = crypto.randomUUID()
      return encodeDoubaoFrame({
        messageType: FULL_CLIENT_REQUEST,
        event: DOUBAO_EVENTS.startSession,
        sessionId,
        payload: buildSessionConfig(pendingConfig),
      })
    },
  }
}

export const DOUBAO_SERVER_MESSAGE_TYPES = { FULL_SERVER_RESPONSE, AUDIO_ONLY_RESPONSE } as const
