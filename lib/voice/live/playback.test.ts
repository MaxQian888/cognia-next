import type {
  AudioBufferLike,
  AudioBufferSourceLike,
  AudioContextLike,
} from "@cognia/tts/streaming/pcm-player"

import { createLiveVoicePlayback } from "./playback"

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

class FakeContext implements AudioContextLike {
  currentTime = 0
  state = "running"
  destination = { connect: jest.fn(), disconnect: jest.fn() }
  sources: FakeSource[] = []
  suspend = jest.fn(async () => undefined)
  resume = jest.fn(async () => undefined)
  close = jest.fn(async () => {
    this.state = "closed"
  })
  createGain = jest.fn(() => ({ gain: { value: 1 }, connect: jest.fn(), disconnect: jest.fn() }))
  createBuffer = jest.fn((_channels: number, length: number) => ({
    getChannelData: () => new Float32Array(length),
  }))
  createBufferSource = jest.fn(() => {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  })
}

/** base64 of `samples` PCM16 samples at max amplitude. */
function delta(samples: number): string {
  const bytes = new Uint8Array(samples * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, 1000, true)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function harness(sampleRate = 24_000) {
  const context = new FakeContext()
  const errors: Error[] = []
  const playback = createLiveVoicePlayback({
    sampleRate,
    audioContextFactory: () => context,
    onError: (error) => errors.push(error),
  })
  return { playback, context, errors }
}

describe("LiveVoicePlayback.enqueueBase64", () => {
  it("schedules a decoded delta", () => {
    const h = harness()

    h.playback.enqueueBase64(delta(2400))

    expect(h.context.createBufferSource).toHaveBeenCalledTimes(1)
    expect(h.context.sources[0].start).toHaveBeenCalled()
  })

  it("queues consecutive deltas back to back on the audio clock", () => {
    const h = harness()

    h.playback.enqueueBase64(delta(24_000)) // 1.0s
    h.playback.enqueueBase64(delta(24_000))

    expect(h.context.sources[0].started).toBe(0)
    expect(h.context.sources[1].started).toBeCloseTo(1, 6)
  })

  it("ignores an empty delta", () => {
    const h = harness()

    h.playback.enqueueBase64("")

    expect(h.context.createBufferSource).not.toHaveBeenCalled()
    expect(h.errors).toHaveLength(0)
  })

  it("reports a malformed delta without tearing down the conversation", () => {
    const h = harness()

    h.playback.enqueueBase64("!!!not base64!!!")

    expect(h.errors).toHaveLength(1)
    expect(h.context.close).not.toHaveBeenCalled()
  })

  it("keeps accepting audio after a malformed delta", () => {
    const h = harness()
    h.playback.enqueueBase64("!!!not base64!!!")

    h.playback.enqueueBase64(delta(2400))

    expect(h.context.createBufferSource).toHaveBeenCalledTimes(1)
  })
})

describe("LiveVoicePlayback barge-in", () => {
  it("stops every scheduled source", () => {
    const h = harness()
    h.playback.enqueueBase64(delta(24_000))
    h.playback.enqueueBase64(delta(24_000))

    h.playback.interrupt()

    for (const source of h.context.sources) expect(source.stop).toHaveBeenCalledWith(0)
  })

  it("reports how much of the reply the user actually heard", () => {
    const h = harness()
    h.playback.enqueueBase64(delta(24_000)) // 1000 ms queued
    h.context.currentTime = 0.35

    expect(h.playback.playedMs()).toBe(350)
  })

  it("caps the played clock at what was scheduled", () => {
    const h = harness()
    h.playback.enqueueBase64(delta(2400)) // 100 ms
    h.context.currentTime = 9

    expect(h.playback.playedMs()).toBe(100)
  })

  it("is zero before any audio arrives", () => {
    expect(harness().playback.playedMs()).toBe(0)
  })

  it("keeps the context open so the next turn reuses it", () => {
    const h = harness()
    h.playback.enqueueBase64(delta(2400))

    h.playback.interrupt()
    h.playback.enqueueBase64(delta(2400))

    expect(h.context.close).not.toHaveBeenCalled()
    expect(h.context.createBufferSource).toHaveBeenCalledTimes(2)
  })

  it("starts the post-interrupt delta immediately rather than behind stale audio", () => {
    const h = harness()
    h.playback.enqueueBase64(delta(24_000))
    h.context.currentTime = 0.25

    h.playback.interrupt()
    h.playback.enqueueBase64(delta(2400))

    expect(h.context.sources[1].started).toBe(0.25)
  })
})

describe("LiveVoicePlayback lifecycle", () => {
  it("survives many turns on one context", () => {
    const h = harness()

    for (let turn = 0; turn < 3; turn++) {
      h.playback.enqueueBase64(delta(2400))
      h.context.sources[turn].onended?.()
      h.playback.endTurn()
    }

    expect(h.context.close).not.toHaveBeenCalled()
    expect(h.context.createBufferSource).toHaveBeenCalledTimes(3)
  })

  it("closes the context on stop", () => {
    const h = harness()
    h.playback.enqueueBase64(delta(2400))

    h.playback.stop()

    expect(h.context.close).toHaveBeenCalled()
    expect(h.playback.state).toBe("ended")
  })

  it("honours the provider downlink rate", () => {
    const h = harness(16_000)

    h.playback.enqueueBase64(delta(1600))

    expect(h.context.createBuffer).toHaveBeenCalledWith(1, 1600, 16_000)
  })
})
