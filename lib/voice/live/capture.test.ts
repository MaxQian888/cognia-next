import {
  MicCapture,
  buildAudioConstraints,
  createMicCapture,
  type CaptureContextLike,
  type CaptureFrame,
  type MediaStreamLike,
  type MicCaptureOptions,
  type WorkletNodeLike,
} from "./capture"

class FakeTrack {
  enabled = true
  stopped = false
  stop() {
    this.stopped = true
  }
}

class FakeStream implements MediaStreamLike {
  readonly tracks = [new FakeTrack()]
  getAudioTracks() {
    return this.tracks
  }
  getTracks() {
    return this.tracks
  }
}

class FakeWorkletNode implements WorkletNodeLike {
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: jest.fn(),
  }
  connected: unknown[] = []
  disconnected = 0
  connect(target: unknown) {
    this.connected.push(target)
  }
  disconnect() {
    this.disconnected++
  }
  /** Simulate a frame arriving from the worklet thread. */
  emitFrame(samples: number[], rms = 0) {
    this.port.onmessage?.({
      data: { type: "frame", samples: new Float32Array(samples), rms },
    })
  }
  emit(data: unknown) {
    this.port.onmessage?.({ data })
  }
}

class FakeSourceNode {
  connected: unknown[] = []
  disconnected = 0
  connect(target: unknown) {
    this.connected.push(target)
  }
  disconnect() {
    this.disconnected++
  }
}

class FakeContext implements CaptureContextLike {
  sampleRate: number
  state = "running"
  closed = false
  resumed = 0
  readonly sources: FakeSourceNode[] = []
  readonly addedModules: string[] = []
  audioWorklet: { addModule(url: string): Promise<void> } | undefined

  constructor(sampleRate: number, supportsWorklet = true) {
    this.sampleRate = sampleRate
    this.audioWorklet = supportsWorklet
      ? {
          addModule: async (url: string) => {
            this.addedModules.push(url)
          },
        }
      : undefined
  }

  createMediaStreamSource() {
    const source = new FakeSourceNode()
    this.sources.push(source)
    return source
  }
  async resume() {
    this.resumed++
    this.state = "running"
  }
  async close() {
    this.closed = true
  }
}

interface Harness {
  capture: MicCapture
  context: FakeContext
  worklet: FakeWorkletNode
  streams: FakeStream[]
  frames: CaptureFrame[]
  errors: Error[]
  revoked: string[]
  getUserMedia: jest.Mock
}

function harness(overrides: Partial<MicCaptureOptions> = {}, contextRate = 24_000): Harness {
  const streams: FakeStream[] = []
  const frames: CaptureFrame[] = []
  const errors: Error[] = []
  const revoked: string[] = []
  const worklet = new FakeWorkletNode()
  const context = new FakeContext(contextRate, overrides.audioContextFactory === undefined)

  const getUserMedia = jest.fn(async () => {
    const stream = new FakeStream()
    streams.push(stream)
    return stream
  })

  const capture = createMicCapture({
    sampleRate: 24_000,
    frameSamples: 480,
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
    getUserMedia,
    audioContextFactory: () => context,
    createWorkletNode: () => worklet,
    createModuleUrl: () => "blob:worklet",
    revokeModuleUrl: (url) => revoked.push(url),
    ...overrides,
  })

  return { capture, context, worklet, streams, frames, errors, revoked, getUserMedia }
}

describe("buildAudioConstraints", () => {
  it("asks for mono voice-optimised input", () => {
    expect(buildAudioConstraints().audio).toEqual({
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    })
  })

  it("pins an exact device when one is selected", () => {
    expect(buildAudioConstraints("mic-2").audio).toMatchObject({
      deviceId: { exact: "mic-2" },
    })
  })
})

describe("MicCapture.start", () => {
  it("wires source → worklet and starts running", async () => {
    const h = harness()

    await h.capture.start()

    expect(h.capture.isRunning).toBe(true)
    expect(h.context.sources[0].connected).toEqual([h.worklet])
  })

  it("acquires the microphone before opening the context", async () => {
    // Ordering matters: a token minted before the permission prompt would
    // spend most of its ~60s lifetime waiting for the user.
    const order: string[] = []
    const h = harness({
      getUserMedia: jest.fn(async () => {
        order.push("getUserMedia")
        return new FakeStream()
      }),
      audioContextFactory: () => {
        order.push("audioContext")
        return new FakeContext(24_000)
      },
    })

    await h.capture.start()

    expect(order).toEqual(["getUserMedia", "audioContext"])
  })

  it("revokes the worklet blob URL after the module loads", async () => {
    const h = harness()

    await h.capture.start()

    expect(h.context.addedModules).toEqual(["blob:worklet"])
    expect(h.revoked).toEqual(["blob:worklet"])
  })

  it("resumes a suspended context so render quanta actually flow", async () => {
    const context = new FakeContext(24_000)
    context.state = "suspended"
    const h = harness({ audioContextFactory: () => context })

    await h.capture.start()

    expect(context.resumed).toBe(1)
  })

  it("does not resume an already-running context", async () => {
    const h = harness()

    await h.capture.start()

    expect(h.context.resumed).toBe(0)
  })

  it("is idempotent", async () => {
    const h = harness()

    await h.capture.start()
    await h.capture.start()

    expect(h.getUserMedia).toHaveBeenCalledTimes(1)
  })

  it("releases the microphone when graph construction fails", async () => {
    const h = harness({
      createWorkletNode: () => {
        throw new Error("worklet node failed")
      },
    })

    await expect(h.capture.start()).rejects.toThrow("worklet node failed")
    expect(h.streams[0].tracks[0].stopped).toBe(true)
    expect(h.context.closed).toBe(true)
    expect(h.capture.isRunning).toBe(false)
  })

  it("fails clearly when the engine has no AudioWorklet", async () => {
    const h = harness({ audioContextFactory: () => new FakeContext(24_000, false) })

    await expect(h.capture.start()).rejects.toThrow(/AudioWorklet is not supported/)
    expect(h.streams[0].tracks[0].stopped).toBe(true)
  })

  it("propagates a denied permission without opening a context", async () => {
    const h = harness({
      getUserMedia: jest.fn().mockRejectedValue(new Error("NotAllowedError")),
    })

    await expect(h.capture.start()).rejects.toThrow("NotAllowedError")
    expect(h.context.closed).toBe(false)
  })

  it("refuses to start after dispose", async () => {
    const h = harness()
    await h.capture.dispose()

    await expect(h.capture.start()).rejects.toThrow(/disposed/)
  })
})

describe("MicCapture sample rate", () => {
  it("reports a match when the engine honours the request", async () => {
    const h = harness()

    await h.capture.start()

    expect(h.capture.sampleRate).toBe(24_000)
    expect(h.capture.sampleRateMatches).toBe(true)
  })

  it("surfaces a clamped rate instead of silently shipping pitched audio", async () => {
    // WKWebView is known to ignore the requested rate and use the hardware one.
    const h = harness({}, 48_000)

    await h.capture.start()

    expect(h.capture.sampleRate).toBe(48_000)
    expect(h.capture.sampleRateMatches).toBe(false)
  })

  it("reports the requested rate before start", () => {
    expect(harness().capture.sampleRate).toBe(24_000)
  })
})

describe("MicCapture frames", () => {
  it("forwards worklet frames to onFrame", async () => {
    const h = harness()
    await h.capture.start()

    h.worklet.emitFrame([0.1, 0.2], 0.5)

    expect(h.frames).toHaveLength(1)
    expect(Array.from(h.frames[0].samples)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
    ])
    expect(h.frames[0].rms).toBe(0.5)
  })

  it("ignores malformed worklet messages", async () => {
    const h = harness()
    await h.capture.start()

    h.worklet.emit(null)
    h.worklet.emit({ type: "frame" })
    h.worklet.emit({ type: "other", samples: new Float32Array(1), rms: 0 })
    h.worklet.emit({ type: "frame", samples: [1, 2], rms: 0 })

    expect(h.frames).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
  })

  it("keeps the graph alive when the consumer throws", async () => {
    const h = harness({
      onFrame: () => {
        throw new Error("consumer blew up")
      },
    })
    await h.capture.start()

    h.worklet.emitFrame([0.1])

    expect(h.errors.map((error) => error.message)).toEqual(["consumer blew up"])
    expect(h.capture.isRunning).toBe(true)
  })
})

describe("MicCapture.setMuted", () => {
  it("disables the track and tells the worklet", async () => {
    const h = harness()
    await h.capture.start()

    h.capture.setMuted(true)

    expect(h.streams[0].tracks[0].enabled).toBe(false)
    expect(h.worklet.port.postMessage).toHaveBeenCalledWith({ type: "mute", muted: true })
    expect(h.capture.isMuted).toBe(true)
  })

  it("re-enables the track on unmute", async () => {
    const h = harness()
    await h.capture.start()
    h.capture.setMuted(true)

    h.capture.setMuted(false)

    expect(h.streams[0].tracks[0].enabled).toBe(true)
    expect(h.capture.isMuted).toBe(false)
  })

  it("never stops the track — that would need a new permission grant", async () => {
    const h = harness()
    await h.capture.start()

    h.capture.setMuted(true)

    expect(h.streams[0].tracks[0].stopped).toBe(false)
  })

  it("applies a mute requested before start once the graph exists", async () => {
    const h = harness()
    h.capture.setMuted(true)

    await h.capture.start()

    expect(h.streams[0].tracks[0].enabled).toBe(false)
    expect(h.worklet.port.postMessage).toHaveBeenCalledWith({ type: "mute", muted: true })
  })
})

describe("MicCapture.setDevice", () => {
  it("swaps the source without recreating the context or worklet", async () => {
    const h = harness()
    await h.capture.start()

    await h.capture.setDevice("mic-2")

    expect(h.context.addedModules).toHaveLength(1)
    expect(h.context.sources).toHaveLength(2)
    expect(h.context.sources[0].disconnected).toBe(1)
    expect(h.context.sources[1].connected).toEqual([h.worklet])
  })

  it("stops the previous stream only after the new one is acquired", async () => {
    const h = harness()
    await h.capture.start()

    await h.capture.setDevice("mic-2")

    expect(h.streams[0].tracks[0].stopped).toBe(true)
    expect(h.streams[1].tracks[0].stopped).toBe(false)
  })

  it("requests the exact device", async () => {
    const h = harness()
    await h.capture.start()

    await h.capture.setDevice("mic-2")

    expect(h.getUserMedia).toHaveBeenLastCalledWith(buildAudioConstraints("mic-2"))
  })

  it("leaves the old microphone running when acquiring the new one fails", async () => {
    const h = harness()
    await h.capture.start()
    h.getUserMedia.mockRejectedValueOnce(new Error("device gone"))

    await expect(h.capture.setDevice("mic-2")).rejects.toThrow("device gone")
    expect(h.streams[0].tracks[0].stopped).toBe(false)
    expect(h.capture.isRunning).toBe(true)
  })

  it("carries mute across the swap", async () => {
    const h = harness()
    await h.capture.start()
    h.capture.setMuted(true)

    await h.capture.setDevice("mic-2")

    expect(h.streams[1].tracks[0].enabled).toBe(false)
  })

  it("only records the preference when capture has not started", async () => {
    const h = harness()

    await h.capture.setDevice("mic-2")
    await h.capture.start()

    expect(h.getUserMedia).toHaveBeenCalledTimes(1)
    expect(h.getUserMedia).toHaveBeenCalledWith(buildAudioConstraints("mic-2"))
  })
})

describe("MicCapture.reset", () => {
  it("tells the worklet to drop its partial frame", async () => {
    const h = harness()
    await h.capture.start()

    h.capture.reset()

    expect(h.worklet.port.postMessage).toHaveBeenCalledWith({ type: "reset" })
  })

  it("is a no-op before start", () => {
    expect(() => harness().capture.reset()).not.toThrow()
  })
})

/**
 * The seams above are injected by every other test, so these cover the real
 * production defaults — the code that actually runs in a browser — including
 * the "not available in this environment" guards a non-browser shell hits.
 */
describe("default environment seams", () => {
  const globals = globalThis as Record<string, unknown>
  const saved: Record<string, unknown> = {}
  const KEYS = ["AudioContext", "webkitAudioContext", "AudioWorkletNode", "navigator"]

  beforeEach(() => {
    for (const key of KEYS) saved[key] = globals[key]
  })

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete globals[key]
      else globals[key] = saved[key]
    }
    jest.restoreAllMocks()
  })

  /** Install a full working browser-ish environment and return the spies. */
  function installBrowserGlobals() {
    const worklet = new FakeWorkletNode()
    const context = new FakeContext(24_000)
    const contextArgs: unknown[] = []
    const stream = new FakeStream()
    const getUserMedia = jest.fn().mockResolvedValue(stream)

    globals.AudioContext = function AudioContextStub(options: unknown) {
      contextArgs.push(options)
      return context
    } as unknown as typeof AudioContext
    globals.AudioWorkletNode = function AudioWorkletNodeStub() {
      return worklet
    } as unknown as typeof AudioWorkletNode
    globals.navigator = { mediaDevices: { getUserMedia } }

    jest.spyOn(URL, "createObjectURL").mockReturnValue("blob:generated")
    const revoke = jest.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

    return { worklet, context, contextArgs, stream, getUserMedia, revoke }
  }

  /** A capture that uses every real default. */
  function bareCapture(overrides: Partial<MicCaptureOptions> = {}) {
    return createMicCapture({
      sampleRate: 24_000,
      frameSamples: 480,
      onFrame: () => undefined,
      ...overrides,
    })
  }

  it("drives the real Web Audio, media and blob-URL defaults end to end", async () => {
    const env = installBrowserGlobals()

    const capture = bareCapture()
    await capture.start()

    expect(env.getUserMedia).toHaveBeenCalledWith(buildAudioConstraints(undefined))
    expect(env.contextArgs).toEqual([{ sampleRate: 24_000, latencyHint: "interactive" }])
    expect(env.context.addedModules).toEqual(["blob:generated"])
    expect(env.revoke).toHaveBeenCalledWith("blob:generated")
    expect(capture.isRunning).toBe(true)
  })

  it("falls back to webkitAudioContext on older Safari-family engines", async () => {
    const env = installBrowserGlobals()
    delete globals.AudioContext
    globals.webkitAudioContext = function WebkitStub() {
      return env.context
    } as unknown as typeof AudioContext

    const capture = bareCapture()
    await capture.start()

    expect(capture.isRunning).toBe(true)
  })

  it("reports a missing Web Audio API", async () => {
    installBrowserGlobals()
    delete globals.AudioContext
    delete globals.webkitAudioContext

    await expect(bareCapture().start()).rejects.toThrow(/Web Audio API is not available/)
  })

  it("reports a missing microphone API", async () => {
    installBrowserGlobals()
    globals.navigator = {}

    await expect(bareCapture().start()).rejects.toThrow(/microphone capture is not available/)
  })

  it("reports a missing AudioWorkletNode constructor", async () => {
    installBrowserGlobals()
    delete globals.AudioWorkletNode

    await expect(bareCapture().start()).rejects.toThrow(/AudioWorklet is not available/)
  })

  it("revokes the generated blob URL even when addModule rejects", async () => {
    const env = installBrowserGlobals()
    env.context.audioWorklet = {
      addModule: jest.fn().mockRejectedValue(new Error("module blocked by CSP")),
    }

    await expect(bareCapture().start()).rejects.toThrow("module blocked by CSP")
    expect(env.revoke).toHaveBeenCalledWith("blob:generated")
    expect(env.stream.tracks[0].stopped).toBe(true)
  })
})

describe("MicCapture.dispose", () => {
  it("releases the microphone, graph and context", async () => {
    const h = harness()
    await h.capture.start()

    await h.capture.dispose()

    expect(h.streams[0].tracks[0].stopped).toBe(true)
    expect(h.worklet.disconnected).toBe(1)
    expect(h.context.sources[0].disconnected).toBe(1)
    expect(h.context.closed).toBe(true)
    expect(h.capture.isRunning).toBe(false)
  })

  it("detaches the port handler so a late frame cannot reach the consumer", async () => {
    const h = harness()
    await h.capture.start()
    const worklet = h.worklet

    await h.capture.dispose()
    worklet.emitFrame([0.1])

    expect(h.frames).toHaveLength(0)
  })

  it("is safe to call repeatedly", async () => {
    const h = harness()
    await h.capture.start()

    await h.capture.dispose()
    await expect(h.capture.dispose()).resolves.toBeUndefined()
  })

  it("survives a context that refuses to close", async () => {
    const context = new FakeContext(24_000)
    context.close = jest.fn().mockRejectedValue(new Error("close failed"))
    const h = harness({ audioContextFactory: () => context })
    await h.capture.start()

    await expect(h.capture.dispose()).resolves.toBeUndefined()
  })
})
