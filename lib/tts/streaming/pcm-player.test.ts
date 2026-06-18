import {
  PcmPlayer,
  pcm16ToFloat32,
  type AudioBufferLike,
  type AudioBufferSourceLike,
  type AudioContextLike,
  type GainNodeLike,
} from "@/lib/tts/streaming/pcm-player"

// ---- Fake Web Audio graph -------------------------------------------------

class FakeBuffer implements AudioBufferLike {
  data: Float32Array
  constructor(length: number) {
    this.data = new Float32Array(length)
  }
  getChannelData() {
    return this.data
  }
}

class FakeSource implements AudioBufferSourceLike {
  buffer: AudioBufferLike | null = null
  onended: (() => void) | null = null
  started: number | null = null
  connect = jest.fn()
  disconnect = jest.fn()
  start = jest.fn((when: number) => {
    this.started = when
  })
  stop = jest.fn()
}

class FakeGain implements GainNodeLike {
  gain = { value: 1 }
  connect = jest.fn()
  disconnect = jest.fn()
}

class FakeContext implements AudioContextLike {
  currentTime = 0
  state = "running"
  destination = { connect: jest.fn(), disconnect: jest.fn() }
  sources: FakeSource[] = []
  suspend = jest.fn(async () => {
    this.state = "suspended"
  })
  resume = jest.fn(async () => {
    this.state = "running"
  })
  close = jest.fn(async () => {
    this.state = "closed"
  })
  createGain = jest.fn(() => new FakeGain())
  createBuffer = jest.fn((_c: number, length: number) => new FakeBuffer(length))
  createBufferSource = jest.fn(() => {
    const s = new FakeSource()
    this.sources.push(s)
    return s
  })
}

/** Build a PCM16 ArrayBuffer of `samples` samples (all max-amplitude). */
function pcm(samples: number): ArrayBuffer {
  const buf = new ArrayBuffer(samples * 2)
  const view = new DataView(buf)
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, 1000, true)
  return buf
}

describe("pcm16ToFloat32", () => {
  it("normalizes signed 16-bit samples to [-1, 1]", () => {
    const buf = new ArrayBuffer(4)
    const view = new DataView(buf)
    view.setInt16(0, 0x7fff, true)
    view.setInt16(2, -0x8000, true)
    const out = pcm16ToFloat32(buf)
    expect(out[0]).toBeCloseTo(1, 5)
    expect(out[1]).toBeCloseTo(-1, 5)
  })

  it("ignores a trailing odd byte", () => {
    expect(pcm16ToFloat32(new ArrayBuffer(3)).length).toBe(1)
  })
})

describe("PcmPlayer", () => {
  function makePlayer(extra: Partial<ConstructorParameters<typeof PcmPlayer>[0]> = {}) {
    const ctx = new FakeContext()
    const onProgress = jest.fn()
    const onEnded = jest.fn()
    const player = new PcmPlayer({
      sampleRate: 24000,
      volume: 0.5,
      audioContextFactory: () => ctx,
      onProgress,
      onEnded,
      ...extra,
    })
    return { ctx, player, onProgress, onEnded }
  }

  it("lazily opens the context and applies volume on first enqueue", () => {
    const { ctx, player } = makePlayer()
    expect(ctx.createGain).not.toHaveBeenCalled()
    player.enqueue(pcm(24000))
    expect(ctx.createGain).toHaveBeenCalledTimes(1)
    expect(ctx.sources[0].start).toHaveBeenCalledWith(0)
    expect(player.getState()).toBe("playing")
  })

  it("schedules chunks back to back on the context clock", () => {
    const { ctx, player } = makePlayer()
    player.enqueue(pcm(24000)) // 1.0s → starts at 0
    player.enqueue(pcm(12000)) // 0.5s → starts at 1.0
    expect(ctx.sources[0].start).toHaveBeenCalledWith(0)
    expect(ctx.sources[1].start).toHaveBeenCalledWith(1)
  })

  it("never schedules in the past when it has fallen behind", () => {
    const { ctx, player } = makePlayer()
    player.enqueue(pcm(2400)) // 0.1s → starts at 0, nextStart = 0.1
    ctx.currentTime = 5 // playback drifted past the scheduled tail
    player.enqueue(pcm(2400))
    expect(ctx.sources[1].start).toHaveBeenCalledWith(5)
  })

  it("ignores empty deltas", () => {
    const { ctx, player } = makePlayer()
    player.enqueue(new ArrayBuffer(1))
    expect(ctx.createBufferSource).not.toHaveBeenCalled()
  })

  it("finishes only after end() and all sources drained", () => {
    const { ctx, player, onEnded, onProgress } = makePlayer()
    player.enqueue(pcm(24000))
    player.enqueue(pcm(24000))
    player.end()
    expect(onEnded).not.toHaveBeenCalled()
    // Drain sources in order.
    ctx.currentTime = 1
    ctx.sources[0].onended?.()
    expect(onEnded).not.toHaveBeenCalled()
    ctx.currentTime = 2
    ctx.sources[1].onended?.()
    expect(onEnded).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenLastCalledWith(1)
    expect(ctx.close).toHaveBeenCalled()
  })

  it("reports fractional progress as sources drain", () => {
    const { ctx, player, onProgress } = makePlayer()
    player.enqueue(pcm(24000)) // 0..1
    player.enqueue(pcm(24000)) // 1..2
    ctx.currentTime = 1
    ctx.sources[0].onended?.()
    expect(onProgress).toHaveBeenLastCalledWith(0.5)
  })

  it("suspends and resumes the context", () => {
    const { ctx, player } = makePlayer()
    player.enqueue(pcm(2400))
    player.pause()
    expect(ctx.suspend).toHaveBeenCalled()
    expect(player.getState()).toBe("paused")
    player.resume()
    expect(ctx.resume).toHaveBeenCalled()
    expect(player.getState()).toBe("playing")
  })

  it("pause is a no-op when not playing", () => {
    const { ctx, player } = makePlayer()
    player.pause()
    expect(ctx.suspend).not.toHaveBeenCalled()
  })

  it("stop closes the context and rejects further input", () => {
    const { ctx, player } = makePlayer()
    player.enqueue(pcm(2400))
    player.stop()
    expect(ctx.close).toHaveBeenCalled()
    expect(player.getState()).toBe("ended")
    player.enqueue(pcm(2400)) // ignored after stop
    expect(ctx.sources.length).toBe(1)
  })

  it("throws a clear error when no AudioContext is available", () => {
    const player = new PcmPlayer({
      audioContextFactory: () => {
        throw new Error("Web Audio API is not available in this environment")
      },
    })
    expect(() => player.enqueue(pcm(2400))).toThrow(/Web Audio API is not available/)
  })

  it("uses the global AudioContext when no factory is injected", () => {
    const fakeCtx = new FakeContext()
    const Ctor = jest.fn(() => fakeCtx)
    ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = Ctor
    try {
      const player = new PcmPlayer({ sampleRate: 24000 })
      player.enqueue(pcm(2400))
      expect(Ctor).toHaveBeenCalledTimes(1)
      expect(fakeCtx.createBufferSource).toHaveBeenCalled()
    } finally {
      delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext
    }
  })

  it("the default factory throws when no Web Audio API exists", () => {
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext
    delete (globalThis as unknown as { webkitAudioContext?: unknown }).webkitAudioContext
    const player = new PcmPlayer({})
    expect(() => player.enqueue(pcm(2400))).toThrow(/Web Audio API is not available/)
  })
})
