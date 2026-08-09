import type {
  Experimental_RealtimeModelV4 as RealtimeModel,
  Experimental_RealtimeModelV4ClientEvent as RealtimeClientEvent,
  Experimental_RealtimeModelV4ServerEvent as RealtimeServerEvent,
} from "@ai-sdk/provider"

import { createLiveVoiceController, type LiveVoiceControllerOptions } from "./controller"
import type { LiveVoiceCapabilities, PreparedRealtimeSession } from "./types"

const trackEventMock = jest.fn()

jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEventMock(...args),
}))

const CAPABILITIES: LiveVoiceCapabilities = {
  supportsTools: true,
  supportsServerVad: true,
  supportsBargeIn: true,
  supportsInputTranscript: true,
  supportsOutputTranscript: true,
  inputSampleRate: 24_000,
  outputSampleRate: 24_000,
  requiresRelay: false,
}

function session(overrides: Partial<PreparedRealtimeSession> = {}): PreparedRealtimeSession {
  return {
    deploymentId: "d1",
    provider: "openai",
    region: "global",
    modelOrResource: "gpt-realtime-2.1",
    token: "ek_secret",
    url: "wss://provider.example/realtime",
    capabilities: CAPABILITIES,
    ...overrides,
  }
}

class FakeTransport {
  sent: RealtimeClientEvent[] = []
  connected: { token: string; url: string } | null = null
  closed: { code?: number; reason?: string } | null = null
  connect(target: { token: string; url: string }) {
    this.connected = target
  }
  send(event: RealtimeClientEvent) {
    this.sent.push(event)
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason }
  }
  get isOpen() {
    return this.connected !== null && this.closed === null
  }
  eventsOfType(type: string) {
    return this.sent.filter((event) => event.type === type)
  }
}

class FakePlayback {
  queued: string[] = []
  interrupts = 0
  turnEnds = 0
  stopped = false
  played = 0
  active = false
  onEnded?: () => void
  enqueueBase64(base64: string) {
    this.queued.push(base64)
    this.active = true
  }
  interrupt() {
    this.interrupts++
    this.played = 0
    this.active = false
  }
  playedMs() {
    return this.played
  }
  endTurn() {
    this.turnEnds++
  }
  drain() {
    this.active = false
    this.onEnded?.()
  }
  stop() {
    this.stopped = true
  }
  get state() {
    return this.active ? "playing" : "idle"
  }
}

class FakeCapture {
  started = false
  disposed = false
  muted = false
  device: string | undefined
  sampleRate: number
  sampleRateMatches: boolean
  onFrame: (frame: { samples: Float32Array; rms: number }) => void
  constructor(
    onFrame: (frame: { samples: Float32Array; rms: number }) => void,
    sampleRate = 24_000,
    matches = true
  ) {
    this.onFrame = onFrame
    this.sampleRate = sampleRate
    this.sampleRateMatches = matches
  }
  async start() {
    this.started = true
  }
  setMuted(muted: boolean) {
    this.muted = muted
  }
  async setDevice(deviceId: string | undefined) {
    this.device = deviceId
  }
  reset() {}
  async dispose() {
    this.disposed = true
  }
  get isRunning() {
    return this.started && !this.disposed
  }
  get isMuted() {
    return this.muted
  }
  emit(samples: number[], rms = 0) {
    this.onFrame({ samples: new Float32Array(samples), rms })
  }
}

function adapter(): RealtimeModel {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake",
    doCreateClientSecret: jest.fn(),
    getWebSocketConfig: ({ url }) => ({ url }),
    parseServerEvent: (raw) => raw as RealtimeServerEvent,
    serializeClientEvent: (event) => event,
    buildSessionConfig: (config) => config,
  } as RealtimeModel
}

interface Hooks {
  onOpen?(): void
  onClose?(info: { code?: number; reason?: string }): void
  onError?(error: Error): void
  onServerEvent?(event: RealtimeServerEvent): void
}

function harness(
  overrides: Partial<LiveVoiceControllerOptions> = {},
  captureConfig: { sampleRate?: number; matches?: boolean } = {}
) {
  const transport = new FakeTransport()
  const playback = new FakePlayback()
  const errors: Error[] = []
  const hooks: Hooks = {}
  let capture: FakeCapture | null = null

  const controller = createLiveVoiceController({
    session: session(),
    adapter: adapter(),
    onError: (error) => errors.push(error),
    createTransport: (options) => {
      Object.assign(hooks, options)
      return transport as never
    },
    createPlayback: (options) => {
      playback.onEnded = options.onEnded
      return playback as never
    },
    createCapture: (options) => {
      capture = new FakeCapture(
        options.onFrame,
        captureConfig.sampleRate ?? 24_000,
        captureConfig.matches ?? true
      )
      return capture as never
    },
    ...overrides,
  })

  return {
    controller,
    transport,
    playback,
    errors,
    hooks,
    getCapture: () => capture,
    /** Complete the handshake: socket open → session-update → mic. */
    async open() {
      hooks.onOpen?.()
      hooks.onServerEvent?.({ type: "session-created", raw: {} } as RealtimeServerEvent)
      hooks.onServerEvent?.({ type: "session-updated", raw: {} } as RealtimeServerEvent)
      await Promise.resolve()
      await Promise.resolve()
    },
    emitServer(event: Record<string, unknown>) {
      hooks.onServerEvent?.({ raw: {}, ...event } as RealtimeServerEvent)
    },
  }
}

const event = (partial: Record<string, unknown>) => partial

beforeEach(() => {
  trackEventMock.mockReset().mockResolvedValue(undefined)
})

describe("start", () => {
  it("dials the minted session", async () => {
    const h = harness()

    await h.controller.start()

    expect(h.transport.connected).toEqual({
      token: "ek_secret",
      url: "wss://provider.example/realtime",
    })
    expect(h.controller.getSnapshot().phase).toBe("connecting")
  })

  it("does not open the microphone before the session is configured", async () => {
    const h = harness()

    await h.controller.start()

    expect(h.getCapture()).toBeNull()
  })

  it("waits for provider readiness and times out when no acknowledgement arrives", async () => {
    jest.useFakeTimers()
    const h = harness({ connectTimeoutMs: 50 })
    await h.controller.start()
    h.hooks.onOpen?.()

    const ready = h.controller.waitUntilReady()
    await jest.advanceTimersByTimeAsync(50)

    await expect(ready).rejects.toThrow("readiness timed out")
    expect(h.controller.getSnapshot().errorInfo?.code).toBe("connection-timeout")
    jest.useRealTimers()
  })

  it("sends session-update, then opens the microphone", async () => {
    const h = harness()
    await h.controller.start()

    await h.open()

    expect(h.transport.sent[0].type).toBe("session-update")
    expect(h.getCapture()?.started).toBe(true)
    expect(h.controller.getSnapshot().phase).toBe("listening")
  })

  it("records connection latency only after provider readiness", async () => {
    let now = 100
    const h = harness({ now: () => now })
    await h.controller.start()

    h.hooks.onOpen?.()
    expect(trackEventMock).not.toHaveBeenCalledWith("voice.connection.ready", expect.anything())

    now = 145
    h.emitServer(event({ type: "session-updated" }))
    await h.controller.waitUntilReady()

    expect(trackEventMock).toHaveBeenCalledWith("voice.connection.ready", {
      provider: "openai",
      durationMs: 45,
    })
  })

  it("is idempotent", async () => {
    const h = harness()

    await h.controller.start()
    await h.controller.start()

    expect(h.transport.connected).not.toBeNull()
    expect(h.transport.sent).toHaveLength(0)
  })

  it("surfaces a connect failure and tears down", async () => {
    const h = harness()
    h.transport.connect = () => {
      throw new Error("dial failed")
    }

    await expect(h.controller.start()).rejects.toThrow("dial failed")
    expect(h.errors.map((error) => error.message)).toEqual(["dial failed"])
  })

  it("surfaces a microphone failure", async () => {
    const h = harness({
      createCapture: () =>
        ({
          start: async () => {
            throw new Error("NotAllowedError")
          },
        }) as never,
    })
    await h.controller.start()

    await h.open()

    expect(h.errors.map((error) => error.message)).toEqual(["NotAllowedError"])
    expect(h.controller.getSnapshot().phase).toBe("error")
  })
})

describe("session config", () => {
  async function configFor(capabilities: Partial<LiveVoiceCapabilities>, extra = {}) {
    const h = harness({
      session: session({ capabilities: { ...CAPABILITIES, ...capabilities } }),
      instructions: "be brief",
      voice: "marin",
      ...extra,
    })
    await h.controller.start()
    await h.open()
    return (h.transport.sent[0] as { config: Record<string, unknown> }).config
  }

  it("carries instructions, voice and audio formats", async () => {
    const config = await configFor({})

    expect(config).toMatchObject({
      instructions: "be brief",
      voice: "marin",
      outputModalities: ["audio"],
      inputAudioFormat: { type: "audio/pcm", rate: 24_000 },
      outputAudioFormat: { type: "audio/pcm", rate: 24_000 },
    })
  })

  it("uses each direction's own rate when they differ", async () => {
    const config = await configFor({ inputSampleRate: 16_000, outputSampleRate: 24_000 })

    expect(config.inputAudioFormat).toEqual({ type: "audio/pcm", rate: 16_000 })
    expect(config.outputAudioFormat).toEqual({ type: "audio/pcm", rate: 24_000 })
  })

  it("uses semantic VAD for OpenAI", async () => {
    expect((await configFor({})).turnDetection).toEqual({ type: "semantic-vad" })
  })

  it("uses server VAD for the other providers", async () => {
    const h = harness({ session: session({ provider: "google" }) })
    await h.controller.start()
    await h.open()

    expect(
      (h.transport.sent[0] as { config: Record<string, unknown> }).config.turnDetection
    ).toEqual({ type: "server-vad" })
  })

  it("disables turn detection when the provider has no server VAD", async () => {
    expect((await configFor({ supportsServerVad: false })).turnDetection).toBeNull()
  })

  it("omits transcription the provider cannot do", async () => {
    const config = await configFor({
      supportsInputTranscript: false,
      supportsOutputTranscript: false,
    })

    expect(config.inputAudioTranscription).toBeUndefined()
    expect(config.outputAudioTranscription).toBeUndefined()
  })

  it("advertises tools when the provider supports them", async () => {
    const tools = [{ type: "function" as const, name: "getWeather", parameters: {} }]

    expect((await configFor({}, { tools })).tools).toEqual(tools)
  })

  it("withholds tools from a provider whose tool support is dormant", async () => {
    // The capability table is the authority, not the caller.
    const tools = [{ type: "function" as const, name: "getWeather", parameters: {} }]

    expect((await configFor({ supportsTools: false }, { tools })).tools).toBeUndefined()
  })
})

describe("uplink frames", () => {
  it("locks the provider after the first captured frame is queued", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()
    const firstFrame = h.controller.waitUntilFirstAudioFrame()

    h.getCapture()?.emit([0, 0.1])

    await expect(firstFrame).resolves.toBeUndefined()
  })

  it("encodes and appends captured audio", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()

    h.getCapture()?.emit([0, 0.5, -0.5])

    const appends = h.transport.eventsOfType("input-audio-append")
    expect(appends).toHaveLength(1)
    expect(typeof (appends[0] as { audio: string }).audio).toBe("string")
  })

  it("resamples when the engine clamped the capture rate", async () => {
    // 48 kHz capture against a 24 kHz wire rate must halve the sample count.
    const h = harness({}, { sampleRate: 48_000, matches: false })
    await h.controller.start()
    await h.open()

    h.getCapture()?.emit(new Array(96).fill(0.25))

    const { audio } = h.transport.eventsOfType("input-audio-append")[0] as { audio: string }
    expect(atob(audio)).toHaveLength(48 * 2)
  })

  it("does not resample when the rate matched", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()

    h.getCapture()?.emit(new Array(48).fill(0.25))

    const { audio } = h.transport.eventsOfType("input-audio-append")[0] as { audio: string }
    expect(atob(audio)).toHaveLength(48 * 2)
  })
})

describe("downlink audio", () => {
  it("queues assistant audio for playback", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()

    h.emitServer(event({ type: "audio-delta", responseId: "r1", itemId: "a1", delta: "QUJD" }))

    expect(h.playback.queued).toEqual(["QUJD"])
  })

  it("settles the turn when the audio completes", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()

    h.emitServer(event({ type: "audio-done", responseId: "r1", itemId: "a1" }))

    expect(h.playback.turnEnds).toBe(1)
  })

  it("records end-of-utterance to first-audio latency", async () => {
    let now = 100
    const h = harness({ now: () => now })
    await h.controller.start()
    await h.open()
    h.emitServer(event({ type: "speech-stopped" }))

    now = 135
    h.emitServer(event({ type: "audio-delta", responseId: "r1", itemId: "a1", delta: "QUJD" }))

    expect(trackEventMock).toHaveBeenCalledWith("voice.first-audio", {
      provider: "openai",
      eouToAudioMs: 35,
    })
  })
})

describe("barge-in", () => {
  async function speaking(playedMs: number) {
    const h = harness()
    await h.controller.start()
    await h.open()
    h.emitServer(event({ type: "audio-delta", responseId: "r1", itemId: "a1", delta: "QUJD" }))
    h.playback.played = playedMs
    return h
  }

  it("cuts playback the moment the user speaks", async () => {
    const h = await speaking(350)

    h.emitServer(event({ type: "speech-started" }))

    expect(h.playback.interrupts).toBe(1)
    expect(trackEventMock).toHaveBeenCalledWith("voice.interrupted", {
      provider: "openai",
      playedMs: 350,
    })
  })

  it("cancels the provider response when the user speaks", async () => {
    const h = await speaking(350)

    h.emitServer(event({ type: "speech-started" }))

    expect(h.transport.eventsOfType("response-cancel")).toEqual([{ type: "response-cancel" }])
  })

  it("truncates the provider's item to what was actually heard", async () => {
    const h = await speaking(350)

    h.emitServer(event({ type: "speech-started" }))

    expect(h.transport.eventsOfType("conversation-item-truncate")).toEqual([
      { type: "conversation-item-truncate", itemId: "a1", contentIndex: 0, audioEndMs: 350 },
    ])
  })

  it("reads the played clock before the cut rewinds it", async () => {
    // interrupt() resets playedMs; computing it after would always send 0.
    const h = await speaking(120)

    h.emitServer(event({ type: "speech-started" }))

    const [truncate] = h.transport.eventsOfType("conversation-item-truncate") as {
      audioEndMs: number
    }[]
    expect(truncate.audioEndMs).toBe(120)
  })

  it("sends no truncate when nothing had been heard yet", async () => {
    const h = await speaking(0)

    h.emitServer(event({ type: "speech-started" }))

    expect(h.transport.eventsOfType("conversation-item-truncate")).toHaveLength(0)
    expect(h.playback.interrupts).toBe(1)
  })

  it("sends no truncate when the assistant was not speaking", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()
    h.playback.played = 400

    h.emitServer(event({ type: "speech-started" }))

    expect(h.transport.eventsOfType("conversation-item-truncate")).toHaveLength(0)
  })

  it("does not truncate the same item twice", async () => {
    const h = await speaking(200)
    h.emitServer(event({ type: "speech-started" }))
    h.playback.played = 200

    h.emitServer(event({ type: "speech-started" }))

    expect(h.transport.eventsOfType("conversation-item-truncate")).toHaveLength(1)
  })

  it("still truncates completed generation while queued audio is playing", async () => {
    const h = await speaking(200)
    h.emitServer(event({ type: "response-done", responseId: "r1", status: "completed" }))
    h.playback.played = 200

    h.emitServer(event({ type: "speech-started" }))

    expect(h.transport.eventsOfType("conversation-item-truncate")).toHaveLength(1)
  })

  it("keeps a fully heard assistant turn when the next user turn starts", async () => {
    const h = await speaking(200)
    h.emitServer(
      event({
        type: "audio-transcript-done",
        responseId: "r1",
        itemId: "a1",
        transcript: "fully heard",
      })
    )
    expect(h.controller.getSnapshot().turns).not.toContainEqual(
      expect.objectContaining({ id: "a1" })
    )
    h.emitServer(event({ type: "audio-done", responseId: "r1", itemId: "a1" }))
    h.playback.drain()
    h.emitServer(event({ type: "response-done", responseId: "r1", status: "completed" }))

    h.emitServer(event({ type: "speech-started" }))

    expect(h.controller.getSnapshot().turns).toContainEqual({
      id: "a1",
      role: "assistant",
      text: "fully heard",
    })
    expect(h.transport.eventsOfType("conversation-item-truncate")).toHaveLength(0)
  })

  it("drops a late final transcript from an interrupted response", async () => {
    const h = await speaking(80)
    h.emitServer(event({ type: "speech-started" }))

    h.emitServer(
      event({
        type: "audio-transcript-done",
        responseId: "r1",
        itemId: "a1",
        transcript: "mostly unheard",
      })
    )

    expect(h.controller.getSnapshot().turns).not.toContainEqual(
      expect.objectContaining({ id: "a1" })
    )
  })

  it("drops a pending final transcript when barge-in happens before playback drains", async () => {
    const h = await speaking(80)
    h.emitServer(
      event({
        type: "audio-transcript-done",
        responseId: "r1",
        itemId: "a1",
        transcript: "generated but not fully heard",
      })
    )
    expect(h.controller.getSnapshot().turns).toHaveLength(0)

    h.emitServer(event({ type: "speech-started" }))
    h.playback.drain()

    expect(h.controller.getSnapshot().turns).toHaveLength(0)
  })

  it("accepts Gemini's next synthetic response after suppressing late output", async () => {
    const h = await speaking(80)
    h.emitServer(event({ type: "speech-started" }))
    h.emitServer(
      event({ type: "text-done", responseId: "r1", itemId: "a1", text: "late old turn" })
    )

    h.emitServer(event({ type: "text-done", responseId: "r2", itemId: "a2", text: "new answer" }))
    h.emitServer(event({ type: "response-done", responseId: "r2", status: "completed" }))

    expect(h.controller.getSnapshot().turns).toContainEqual({
      id: "a2",
      role: "assistant",
      text: "new answer",
    })
    expect(h.controller.getSnapshot().turns).not.toContainEqual(
      expect.objectContaining({ id: "a1" })
    )
  })
})

describe("state store", () => {
  it("notifies subscribers when state changes", async () => {
    const h = harness()
    const listener = jest.fn()
    h.controller.subscribe(listener)

    await h.controller.start()

    expect(listener).toHaveBeenCalled()
  })

  it("does not notify for an event the reducer ignores", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()
    const listener = jest.fn()
    h.controller.subscribe(listener)

    h.emitServer(event({ type: "audio-delta", responseId: "r1", itemId: "a1", delta: "QUJD" }))

    expect(listener).not.toHaveBeenCalled()
  })

  it("stops notifying after unsubscribe", async () => {
    const h = harness()
    const listener = jest.fn()
    const unsubscribe = h.controller.subscribe(listener)
    unsubscribe()

    await h.controller.start()

    expect(listener).not.toHaveBeenCalled()
  })

  it("folds transcripts into the snapshot", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()

    h.emitServer(
      event({ type: "input-transcription-completed", itemId: "u1", transcript: "hello there" })
    )

    expect(h.controller.getSnapshot().turns).toEqual([
      { id: "u1", role: "user", text: "hello there" },
    ])
  })
})

describe("input level store", () => {
  it("publishes at most ten level updates per second without touching session state", async () => {
    let now = 0
    const h = harness({ now: () => now })
    await h.controller.start()
    await h.open()
    const stateListener = jest.fn()
    const levelListener = jest.fn()
    h.controller.subscribe(stateListener)
    h.controller.subscribeInputLevel(levelListener)

    h.getCapture()?.emit([0.2], 0.2)
    now = 20
    h.getCapture()?.emit([0.8], 0.8)
    now = 100
    h.getCapture()?.emit([0.6], 0.6)

    expect(levelListener).toHaveBeenCalledTimes(2)
    expect(h.controller.getInputLevelSnapshot()).toBe(0.6)
    expect(stateListener).not.toHaveBeenCalled()
  })

  it("drops the meter to zero immediately when muted", async () => {
    const h = harness({ now: () => 100 })
    await h.controller.start()
    await h.open()
    h.getCapture()?.emit([0.7], 0.7)
    const listener = jest.fn()
    h.controller.subscribeInputLevel(listener)

    h.controller.setMuted(true)

    expect(h.controller.getInputLevelSnapshot()).toBe(0)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("mute", () => {
  it("mutes the microphone and clears the server buffer", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()

    h.controller.setMuted(true)

    expect(h.getCapture()?.muted).toBe(true)
    expect(h.transport.eventsOfType("input-audio-clear")).toHaveLength(1)
    expect(h.controller.getSnapshot().muted).toBe(true)
  })

  it("does not clear the buffer on unmute", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()
    h.controller.setMuted(true)

    h.controller.setMuted(false)

    expect(h.transport.eventsOfType("input-audio-clear")).toHaveLength(1)
    expect(h.getCapture()?.muted).toBe(false)
  })

  it("applies a mute requested before the microphone opened", async () => {
    const h = harness()
    await h.controller.start()
    h.controller.setMuted(true)

    await h.open()

    expect(h.getCapture()?.muted).toBe(true)
  })
})

describe("device switching", () => {
  it("forwards the device to the capture graph", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()

    await h.controller.setDevice("mic-2")

    expect(h.getCapture()?.device).toBe("mic-2")
  })

  it("is a no-op before the microphone opens", async () => {
    const h = harness()

    await expect(h.controller.setDevice("mic-2")).resolves.toBeUndefined()
  })
})

describe("teardown", () => {
  it("releases microphone, playback and socket", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()
    const capture = h.getCapture()

    await h.controller.stop()

    expect(capture?.disposed).toBe(true)
    expect(h.playback.stopped).toBe(true)
    expect(h.transport.closed).toEqual({ code: 1000, reason: "client ended session" })
    expect(h.controller.getSnapshot().phase).toBe("idle")
  })

  it("is safe to call repeatedly", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()

    await h.controller.stop()
    await expect(h.controller.stop()).resolves.toBeUndefined()
  })

  it("allows a fresh session afterwards", async () => {
    const h = harness()
    await h.controller.start()
    await h.controller.stop()

    await h.controller.start()

    expect(h.transport.connected).not.toBeNull()
  })

  it("seeds the original context again when the controller starts a fresh session", async () => {
    const h = harness({ contextTranscript: "User: previous question" })
    await h.controller.start()
    await h.open()
    await h.controller.stop()

    await h.controller.start()
    await h.open()

    expect(h.transport.eventsOfType("conversation-item-create")).toHaveLength(2)
  })

  it("rejects PII in the final session update before it reaches the transport", async () => {
    const h = harness({
      sessionConfig: {
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Send output to bob@example.com",
            parameters: {},
          },
        ],
      },
    })
    await h.controller.start()

    h.hooks.onOpen?.()
    await Promise.resolve()

    expect(h.transport.eventsOfType("session-update")).toHaveLength(0)
    expect(h.controller.getSnapshot().phase).toBe("error")
  })

  it("reports an unexpected close as an error", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()

    h.hooks.onClose?.({ code: 1006 })

    expect(h.controller.getSnapshot().phase).toBe("error")
    expect(h.controller.getSnapshot().error).toBe("Realtime connection was lost")
  })

  it("stays quiet about a close we initiated", async () => {
    const h = harness()
    await h.controller.start()
    await h.open()

    await h.controller.stop()
    h.hooks.onClose?.({ code: 1000 })

    expect(h.controller.getSnapshot().phase).toBe("idle")
  })

  it("surfaces a transport error", async () => {
    const h = harness()
    await h.controller.start()

    h.hooks.onError?.(new Error("socket exploded"))

    expect(h.errors.map((error) => error.message)).toEqual(["socket exploded"])
    expect(h.controller.getSnapshot().error).toBe("socket exploded")
    expect(trackEventMock).toHaveBeenCalledWith("voice.error", {
      provider: "openai",
      code: "provider-error",
    })
  })
})

describe("same-provider recovery", () => {
  it("ignores callbacks from a transport replaced during recovery", async () => {
    const generations: Array<{ hooks: Hooks; transport: FakeTransport }> = []
    const reconnectSession = jest.fn().mockResolvedValue({
      session: session({ token: "fresh-token" }),
      adapter: adapter(),
      sessionConfig: { turnDetection: { type: "semantic-vad" } },
    })
    const h = harness({
      reconnectSession,
      sleep: async () => undefined,
      createTransport: (options) => {
        const generation = { hooks: options, transport: new FakeTransport() }
        generations.push(generation)
        return generation.transport as never
      },
    })
    await h.controller.start()
    generations[0].hooks.onOpen?.()
    generations[0].hooks.onServerEvent?.(event({ type: "session-updated" }) as RealtimeServerEvent)
    await Promise.resolve()
    h.getCapture()?.emit([0])

    generations[0].hooks.onClose?.({ code: 1006 })
    await Promise.resolve()
    await Promise.resolve()
    expect(generations).toHaveLength(2)
    generations[1].hooks.onOpen?.()
    generations[1].hooks.onServerEvent?.(event({ type: "session-updated" }) as RealtimeServerEvent)
    await Promise.resolve()

    generations[0].hooks.onError?.(new Error("stale socket error"))
    generations[0].hooks.onServerEvent?.(
      event({ type: "error", message: "stale provider error" }) as RealtimeServerEvent
    )
    generations[0].hooks.onClose?.({ code: 1006 })

    expect(reconnectSession).toHaveBeenCalledTimes(1)
    expect(h.controller.getSnapshot().phase).toBe("listening")
    expect(h.controller.getSnapshot().error).toBeUndefined()
  })

  it("returns a pre-first-frame disconnect to the initial fallback owner", async () => {
    const reconnectSession = jest.fn()
    const h = harness({ reconnectSession })
    await h.controller.start()
    await h.open()
    const firstFrame = h.controller.waitUntilFirstAudioFrame()

    h.hooks.onClose?.({ code: 1006 })

    await expect(firstFrame).rejects.toThrow("connection was lost")
    expect(reconnectSession).not.toHaveBeenCalled()
  })

  it("closes an open transport before a manual retry", async () => {
    const reconnectSession = jest.fn().mockResolvedValue({
      session: session({ token: "manual-token" }),
      adapter: adapter(),
      sessionConfig: { turnDetection: { type: "semantic-vad" } },
    })
    const h = harness({ reconnectSession, sleep: async () => undefined })
    await h.controller.start()
    await h.open()
    h.getCapture()?.emit([0])
    h.hooks.onError?.(new Error("provider overloaded"))

    const retry = h.controller.retry()
    await Promise.resolve()

    expect(h.transport.closed).toEqual({ code: 4004, reason: "manual reconnect" })
    expect(reconnectSession).toHaveBeenCalledTimes(1)
    h.hooks.onOpen?.()
    h.emitServer(event({ type: "session-updated" }))
    await retry
  })

  it("re-mints the locked provider after an unexpected close", async () => {
    const reconnectSession = jest.fn().mockResolvedValue({
      session: session({ token: "fresh-token" }),
      adapter: adapter(),
      sessionConfig: { turnDetection: { type: "semantic-vad" } },
    })
    const h = harness({ reconnectSession, sleep: async () => undefined })
    await h.controller.start()
    await h.open()
    h.getCapture()?.emit([0])

    h.hooks.onClose?.({ code: 1006, reason: "network" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reconnectSession).toHaveBeenCalledTimes(1)
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: "reconnecting",
      reconnect: { attempt: 1, maxAttempts: 3 },
    })
    h.hooks.onOpen?.()
    h.emitServer(event({ type: "session-updated" }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.controller.getSnapshot().phase).toBe("listening")
    expect(trackEventMock).toHaveBeenCalledWith("voice.reconnect", {
      provider: "openai",
      attempt: 1,
      outcome: "succeeded",
    })
  })

  it("rejects a reconnect result that tries to switch providers", async () => {
    const reconnectSession = jest.fn().mockResolvedValue({
      session: session({ provider: "google", token: "wrong-provider" }),
      adapter: adapter(),
      sessionConfig: { turnDetection: { type: "server-vad" } },
    })
    const h = harness({ reconnectSession, sleep: async () => undefined })
    await h.controller.start()
    await h.open()
    h.getCapture()?.emit([0])

    h.hooks.onClose?.({ code: 1006 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reconnectSession).toHaveBeenCalledTimes(3)
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: "error",
      error: "Realtime reconnect attempted to switch providers",
    })
  })

  it("uses the bounded 0ms, 1s, 2s retry budget", async () => {
    const reconnectSession = jest.fn().mockRejectedValue(new Error("network down"))
    const sleep = jest.fn(async () => undefined)
    const h = harness({ reconnectSession, sleep })
    await h.controller.start()
    await h.open()
    h.getCapture()?.emit([0])

    h.hooks.onClose?.({ code: 1006 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reconnectSession).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls).toEqual([[1_000], [2_000]])
    expect(h.controller.getSnapshot().phase).toBe("error")
    expect(h.controller.getSnapshot().errorInfo?.code).toBe("network")
    expect(trackEventMock).toHaveBeenCalledWith("voice.reconnect", {
      provider: "openai",
      attempt: 1,
      outcome: "started",
    })
    expect(trackEventMock).toHaveBeenCalledWith("voice.reconnect", {
      provider: "openai",
      attempt: 3,
      outcome: "failed",
    })
  })

  it("passes Gemini's native resumption handle into the next mint", async () => {
    const reconnectSession = jest.fn().mockResolvedValue({
      session: session({ provider: "google", token: "fresh-google" }),
      adapter: adapter(),
      sessionConfig: { turnDetection: { type: "server-vad" } },
    })
    const h = harness({
      session: session({ provider: "google" }),
      reconnectSession,
      sleep: async () => undefined,
    })
    await h.controller.start()
    await h.open()
    h.getCapture()?.emit([0])
    h.emitServer(
      event({
        type: "custom",
        rawType: "sessionResumptionUpdate",
        raw: { sessionResumptionUpdate: { resumable: true, newHandle: "resume-42" } },
      })
    )

    h.emitServer(event({ type: "custom", rawType: "goAway", raw: { goAway: {} } }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reconnectSession).toHaveBeenCalledWith({ resumptionHandle: "resume-42" })
  })

  it("replays only completed text turns after a non-Gemini reconnect", async () => {
    const reconnectSession = jest.fn().mockResolvedValue({
      session: session({ token: "fresh-token" }),
      adapter: adapter(),
      sessionConfig: { turnDetection: { type: "semantic-vad" } },
    })
    const h = harness({ reconnectSession, sleep: async () => undefined })
    await h.controller.start()
    await h.open()
    h.getCapture()?.emit([0])
    h.emitServer(
      event({
        type: "input-transcription-completed",
        itemId: "u1",
        transcript: "finished question",
      })
    )
    h.emitServer(
      event({ type: "text-done", responseId: "r1", itemId: "a1", text: "finished answer" })
    )
    h.emitServer(event({ type: "response-done", responseId: "r1", status: "completed" }))
    h.emitServer(
      event({ type: "text-delta", responseId: "r2", itemId: "a2", delta: "unverified draft" })
    )

    h.hooks.onClose?.({ code: 1006 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.hooks.onOpen?.()
    h.emitServer(event({ type: "session-updated" }))
    await Promise.resolve()

    const replay = h.transport.eventsOfType("conversation-item-create").at(-1)
    expect(replay).toEqual({
      type: "conversation-item-create",
      item: {
        type: "text-message",
        role: "user",
        text: "User: finished question\nAssistant: finished answer",
      },
    })
    expect(JSON.stringify(replay)).not.toContain("unverified draft")
  })

  it("cancels pending recovery when the user ends the session", async () => {
    let release: (() => void) | undefined
    const reconnectSession = jest.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          release = () => reject(new Error("late failure"))
        })
    )
    const h = harness({ reconnectSession, sleep: async () => undefined })
    await h.controller.start()
    await h.open()
    h.getCapture()?.emit([0])
    h.hooks.onClose?.({ code: 1006 })
    await Promise.resolve()

    await h.controller.stop()
    release?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reconnectSession).toHaveBeenCalledTimes(1)
    expect(h.controller.getSnapshot().phase).toBe("idle")
  })
})

describe("context injection", () => {
  it("seeds the conversation before the microphone opens", async () => {
    // The model has to be oriented on the user's first word, not a sentence
    // later — and the seed must land after session-update so it is interpreted
    // against the configured session.
    const h = harness({ contextTranscript: "User: what about it" })

    await h.controller.start()
    await h.open()

    expect(h.transport.sent.map((e) => e.type)).toEqual([
      "session-update",
      "conversation-item-create",
    ])
    expect(h.transport.sent[1]).toEqual({
      type: "conversation-item-create",
      item: { type: "text-message", role: "user", text: "User: what about it" },
    })
  })

  it("sends nothing when there is no history to seed", async () => {
    const h = harness()

    await h.controller.start()
    await h.open()

    expect(h.transport.eventsOfType("conversation-item-create")).toHaveLength(0)
  })
})

describe("tool calling", () => {
  const toolCall = event({
    type: "function-call-arguments-done",
    responseId: "r1",
    itemId: "i1",
    callId: "call_1",
    name: "search_notes",
    arguments: '{"q":"hi"}',
  })

  function toolHarness(execute: jest.Mock) {
    return harness({
      toolExecution: {
        sessionId: "chat-1",
        // An explicit allow keeps the approval dialog out of this test; the
        // ask path is covered in approval.test.ts.
        policy: { toolRules: { search_notes: "allow" } },
        execute,
      },
    })
  }

  it("runs the tool and returns its output", async () => {
    const execute = jest.fn(async () => ({ result: { hits: 2 } }))
    const h = toolHarness(execute)
    await h.controller.start()
    await h.open()

    h.emitServer(toolCall)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: "search_notes", args: { q: "hi" } })
    )
    expect(h.transport.eventsOfType("conversation-item-create").at(-1)).toEqual({
      type: "conversation-item-create",
      item: {
        type: "function-call-output",
        callId: "call_1",
        name: "search_notes",
        output: '{"hits":2}',
      },
    })
    expect(h.transport.eventsOfType("response-create")).toHaveLength(1)
    expect(trackEventMock).toHaveBeenCalledWith(
      "voice.tool.completed",
      expect.objectContaining({ provider: "openai", status: "completed" })
    )
  })

  it("honours Gemini tool-call cancellation and drops the late output", async () => {
    let releaseExecute: ((value: { result: unknown }) => void) | undefined
    const execute = jest.fn(
      () =>
        new Promise<{ result: unknown }>((resolve) => {
          releaseExecute = resolve
        })
    )
    const h = harness({
      session: session({ provider: "google" }),
      toolExecution: {
        sessionId: "chat-1",
        policy: { toolRules: { search_notes: "allow" } },
        execute,
      },
    })
    await h.controller.start()
    await h.open()
    h.emitServer(toolCall)
    await Promise.resolve()

    h.emitServer(
      event({
        type: "custom",
        rawType: "toolCallCancellation",
        raw: { toolCallCancellation: { ids: ["call_1"] } },
      })
    )
    releaseExecute?.({ result: { too: "late" } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(h.transport.eventsOfType("conversation-item-create")).toHaveLength(0)
    expect(trackEventMock).toHaveBeenCalledWith(
      "voice.tool.completed",
      expect.objectContaining({ provider: "google", status: "cancelled" })
    )
  })

  it("answers a tool call even with no executor configured", async () => {
    // A function call left without an output stalls the model mid-conversation
    // with the microphone open, which reads as the assistant having frozen.
    const h = harness()
    await h.controller.start()
    await h.open()

    h.emitServer(toolCall)

    const output = h.transport.eventsOfType("conversation-item-create").at(-1)
    expect(output).toMatchObject({
      item: { callId: "call_1", output: expect.stringContaining("not available") },
    })
    expect(h.transport.eventsOfType("response-create")).toHaveLength(1)
  })

  it("drops a tool result once the session has been stopped", async () => {
    // Its callId means nothing to whatever session comes next, and most
    // providers treat that as fatal.
    let finish: (value: { result: unknown }) => void = () => {}
    const execute = jest.fn(() => new Promise((resolve) => (finish = resolve)))
    const h = toolHarness(execute as unknown as jest.Mock)
    await h.controller.start()
    await h.open()

    h.emitServer(toolCall)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await h.controller.stop()
    finish({ result: "too late" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(h.transport.eventsOfType("conversation-item-create")).toHaveLength(0)
  })
})
