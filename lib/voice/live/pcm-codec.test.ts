import {
  FRAME_SAMPLES_20MS_24KHZ,
  base64ToPcm16Buffer,
  computeRms,
  createFrameAccumulator,
  decodeDownlinkAudio,
  encodeUplinkAudio,
  resampleAudio,
} from "./pcm-codec"

/** Build a base64 PCM16 LE payload from signed 16-bit sample values. */
function pcm16Base64(samples: number[]): string {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

describe("base64ToPcm16Buffer", () => {
  it("decodes base64 PCM16 into the original little-endian bytes", () => {
    const buffer = base64ToPcm16Buffer(pcm16Base64([0, 1, -1, 32767, -32768]))
    const view = new DataView(buffer)

    expect(buffer.byteLength).toBe(10)
    expect(view.getInt16(0, true)).toBe(0)
    expect(view.getInt16(2, true)).toBe(1)
    expect(view.getInt16(4, true)).toBe(-1)
    expect(view.getInt16(6, true)).toBe(32767)
    expect(view.getInt16(8, true)).toBe(-32768)
  })

  it("returns an empty buffer for an empty payload", () => {
    expect(base64ToPcm16Buffer("").byteLength).toBe(0)
  })

  it("truncates a dangling half-sample instead of throwing", () => {
    // Three bytes cannot form whole PCM16 samples; the odd tail is dropped.
    const oddPayload = btoa("\x01\x02\x03")

    const buffer = base64ToPcm16Buffer(oddPayload)

    expect(buffer.byteLength).toBe(2)
    expect(new DataView(buffer).getInt16(0, true)).toBe(0x0201)
  })
})

describe("computeRms", () => {
  it("is zero for an empty block", () => {
    expect(computeRms(new Float32Array(0))).toBe(0)
  })

  it("is zero for silence", () => {
    expect(computeRms(new Float32Array(64))).toBe(0)
  })

  it("is the magnitude for a constant block", () => {
    expect(computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 10)
  })

  it("rises with amplitude", () => {
    const quiet = computeRms(new Float32Array([0.1, -0.1]))
    const loud = computeRms(new Float32Array([0.9, -0.9]))

    expect(loud).toBeGreaterThan(quiet)
  })
})

describe("createFrameAccumulator", () => {
  it("rejects a non-positive or non-integer frame size", () => {
    expect(() => createFrameAccumulator(0)).toThrow(/positive integer/)
    expect(() => createFrameAccumulator(-4)).toThrow(/positive integer/)
    expect(() => createFrameAccumulator(1.5)).toThrow(/positive integer/)
  })

  it("buffers a short chunk without emitting", () => {
    const accumulator = createFrameAccumulator(4)

    expect(accumulator.push(new Float32Array([1, 2]))).toEqual([])
    expect(accumulator.pending).toBe(2)
  })

  it("emits exactly one frame when a chunk completes it", () => {
    const accumulator = createFrameAccumulator(4)
    accumulator.push(new Float32Array([1, 2]))

    const frames = accumulator.push(new Float32Array([3, 4]))

    expect(frames).toHaveLength(1)
    expect(Array.from(frames[0])).toEqual([1, 2, 3, 4])
    expect(accumulator.pending).toBe(0)
  })

  it("splits an oversized chunk into whole frames and keeps the remainder", () => {
    const accumulator = createFrameAccumulator(3)

    const frames = accumulator.push(new Float32Array([1, 2, 3, 4, 5, 6, 7]))

    expect(frames.map((frame) => Array.from(frame))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ])
    expect(accumulator.pending).toBe(1)
  })

  it("preserves sample order across many uneven pushes", () => {
    const accumulator = createFrameAccumulator(4)
    const emitted: number[] = []

    // 1 + 4 + 2 + 6 = 13 samples at frame size 4 → three whole frames, one left over.
    for (const chunk of [[1], [2, 3, 4, 5], [6, 7], [8, 9, 10, 11, 12, 13]]) {
      for (const frame of accumulator.push(new Float32Array(chunk))) {
        emitted.push(...Array.from(frame))
      }
    }

    expect(emitted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(accumulator.pending).toBe(1)

    const remainder = accumulator.flush()
    expect(remainder && Array.from(remainder)).toEqual([13])
  })

  it("hands out frames the caller can retain — later pushes never mutate them", () => {
    const accumulator = createFrameAccumulator(2)
    const [first] = accumulator.push(new Float32Array([1, 2]))

    accumulator.push(new Float32Array([9, 9]))

    expect(Array.from(first)).toEqual([1, 2])
  })

  it("ignores an empty chunk", () => {
    const accumulator = createFrameAccumulator(4)

    expect(accumulator.push(new Float32Array(0))).toEqual([])
    expect(accumulator.pending).toBe(0)
  })

  it("flushes the remainder as a short frame and resets", () => {
    const accumulator = createFrameAccumulator(4)
    accumulator.push(new Float32Array([1, 2, 3]))

    const remainder = accumulator.flush()

    expect(remainder && Array.from(remainder)).toEqual([1, 2, 3])
    expect(accumulator.pending).toBe(0)
    expect(accumulator.flush()).toBeNull()
  })

  it("drops buffered samples on reset without emitting them", () => {
    const accumulator = createFrameAccumulator(4)
    accumulator.push(new Float32Array([1, 2, 3]))

    accumulator.reset()

    expect(accumulator.pending).toBe(0)
    expect(accumulator.flush()).toBeNull()
  })

  it("starts a clean frame after reset", () => {
    const accumulator = createFrameAccumulator(2)
    accumulator.push(new Float32Array([7]))
    accumulator.reset()

    const frames = accumulator.push(new Float32Array([1, 2]))

    expect(Array.from(frames[0])).toEqual([1, 2])
  })
})

describe("re-exported AI SDK audio utils", () => {
  it("round-trips Float32 samples through the uplink encoder", () => {
    const decoded = decodeDownlinkAudio(encodeUplinkAudio(new Float32Array([0, 0.5, -0.5])))

    expect(decoded).toHaveLength(3)
    expect(decoded[0]).toBeCloseTo(0, 3)
    expect(decoded[1]).toBeCloseTo(0.5, 3)
    expect(decoded[2]).toBeCloseTo(-0.5, 3)
  })

  it("produces bytes our own decoder agrees with", () => {
    // Pins the two directions against each other: the uplink encoder and the
    // downlink buffer decoder must share one PCM16 LE interpretation.
    const buffer = base64ToPcm16Buffer(encodeUplinkAudio(new Float32Array([1, -1])))
    const view = new DataView(buffer)

    expect(view.getInt16(0, true)).toBe(32767)
    expect(view.getInt16(2, true)).toBe(-32768)
  })

  it("halves the sample count when downsampling 48k to 24k", () => {
    const input = new Float32Array(96).map((_, i) => Math.sin(i / 4))

    expect(resampleAudio(input, 48000, 24000)).toHaveLength(48)
  })

  it("returns the input untouched when the rates match", () => {
    const input = new Float32Array([0.1, 0.2])

    expect(resampleAudio(input, 24000, 24000)).toBe(input)
  })
})

describe("FRAME_SAMPLES_20MS_24KHZ", () => {
  it("is 20 ms of 24 kHz mono audio", () => {
    expect(FRAME_SAMPLES_20MS_24KHZ).toBe((24000 * 20) / 1000)
  })
})
