import {
  DOUBAO_EVENTS,
  createDoubaoLiveAdapter,
  decodeDoubaoFrame,
  encodeDoubaoFrame,
} from "./doubao-adapter"
import fixtures from "./protocol-fixtures.json"

describe("Doubao binary framing", () => {
  it("decodes a sanitized server lifecycle fixture", () => {
    const bytes = Uint8Array.from(Buffer.from(fixtures.doubao.sessionStartedBase64, "base64"))
    expect(decodeDoubaoFrame(bytes)).toMatchObject({
      messageType: 9,
      event: DOUBAO_EVENTS.sessionStarted,
      sessionId: "s1",
    })
  })
  it("round-trips JSON and gzip audio frames", () => {
    expect(
      decodeDoubaoFrame(
        encodeDoubaoFrame({
          messageType: 1,
          event: DOUBAO_EVENTS.startSession,
          sessionId: "s1",
          payload: { hello: "world" },
        })
      )
    ).toMatchObject({
      event: DOUBAO_EVENTS.startSession,
      sessionId: "s1",
      payload: { hello: "world" },
    })
    expect(
      decodeDoubaoFrame(
        encodeDoubaoFrame({
          messageType: 2,
          event: DOUBAO_EVENTS.taskRequest,
          sessionId: "s1",
          payload: new Uint8Array([1, 2, 3]),
          gzip: true,
        })
      ).payload
    ).toEqual(new Uint8Array([1, 2, 3]))
  })

  it("rejects partial, malformed and trailing frames", () => {
    expect(() => decodeDoubaoFrame(new Uint8Array([0x11]))).toThrow(/truncated/)
    const valid = encodeDoubaoFrame({ messageType: 1, event: 1 })
    expect(() => decodeDoubaoFrame(valid.subarray(0, valid.length - 1))).toThrow(/partial/)
    expect(() => decodeDoubaoFrame(new Uint8Array([...valid, 0]))).toThrow(/trailing/)
  })
})

describe("Doubao live adapter", () => {
  it("orders connection and session lifecycle before gzip PCM input", () => {
    const adapter = createDoubaoLiveAdapter("service-selected")
    const start = adapter.serializeClientEvent({ type: "session-update", config: { voice: "v1" } })
    expect(decodeDoubaoFrame(start as Uint8Array).event).toBe(DOUBAO_EVENTS.startConnection)

    const connectionStarted = encodeDoubaoFrame({
      messageType: 9,
      event: DOUBAO_EVENTS.connectionStarted,
    })
    const startSession = adapter.getHealthCheckResponse?.(connectionStarted) as Uint8Array
    const sessionFrame = decodeDoubaoFrame(startSession)
    expect(sessionFrame.event).toBe(DOUBAO_EVENTS.startSession)
    expect(sessionFrame.sessionId).toBeTruthy()

    const sessionStarted = encodeDoubaoFrame({
      messageType: 9,
      event: DOUBAO_EVENTS.sessionStarted,
      sessionId: sessionFrame.sessionId,
    })
    expect(adapter.parseServerEvent(sessionStarted)).toMatchObject({ type: "session-updated" })

    const audio = adapter.serializeClientEvent({ type: "input-audio-append", audio: "AQID" })
    expect(decodeDoubaoFrame(audio as Uint8Array)).toMatchObject({
      event: DOUBAO_EVENTS.taskRequest,
      payload: new Uint8Array([1, 2, 3]),
    })
  })

  it("maps audio, interruption, transcripts and errors without tools", () => {
    const adapter = createDoubaoLiveAdapter("service-selected")
    adapter.serializeClientEvent({ type: "session-update", config: {} })
    const connection = encodeDoubaoFrame({ messageType: 9, event: DOUBAO_EVENTS.connectionStarted })
    const startSession = decodeDoubaoFrame(
      adapter.getHealthCheckResponse?.(connection) as Uint8Array
    )
    adapter.parseServerEvent(
      encodeDoubaoFrame({
        messageType: 9,
        event: DOUBAO_EVENTS.sessionStarted,
        sessionId: startSession.sessionId,
      })
    )

    expect(
      adapter.parseServerEvent(
        encodeDoubaoFrame({
          messageType: 9,
          event: DOUBAO_EVENTS.asrResponse,
          sessionId: startSession.sessionId,
          payload: { text: "你" },
        })
      )
    ).toMatchObject({ type: "custom", rawType: "doubao.asr.delta" })
    const firstFinal = adapter.parseServerEvent(
      encodeDoubaoFrame({
        messageType: 9,
        event: DOUBAO_EVENTS.asrEnded,
        sessionId: startSession.sessionId,
        payload: { text: "你好" },
      })
    )
    const secondFinal = adapter.parseServerEvent(
      encodeDoubaoFrame({
        messageType: 9,
        event: DOUBAO_EVENTS.asrEnded,
        sessionId: startSession.sessionId,
        payload: { text: "再见" },
      })
    )
    expect(firstFinal).toMatchObject({ type: "input-transcription-completed", transcript: "你好" })
    expect(secondFinal).toMatchObject({
      type: "input-transcription-completed",
      transcript: "再见",
    })
    expect((secondFinal as { itemId: string }).itemId).not.toBe(
      (firstFinal as { itemId: string }).itemId
    )
    expect(
      adapter.parseServerEvent(
        encodeDoubaoFrame({
          messageType: 0xb,
          event: DOUBAO_EVENTS.ttsResponse,
          sessionId: startSession.sessionId,
          payload: new Uint8Array([1, 2]),
        })
      )
    ).toMatchObject({ type: "audio-delta", delta: "AQI=" })
    expect(
      adapter.parseServerEvent(
        encodeDoubaoFrame({
          messageType: 9,
          event: DOUBAO_EVENTS.audioMuted,
          sessionId: startSession.sessionId,
        })
      )
    ).toMatchObject({ type: "speech-started" })
    expect(
      adapter.parseServerEvent(
        encodeDoubaoFrame({
          messageType: 0xf,
          event: DOUBAO_EVENTS.sessionFailed,
          payload: { text: "denied", code: "401" },
        })
      )
    ).toMatchObject({ type: "error", message: "denied", code: "401" })
    expect(
      adapter.serializeClientEvent({
        type: "conversation-item-create",
        item: { type: "text-message", role: "user", text: "no tools" },
      })
    ).toBeNull()
  })
})
