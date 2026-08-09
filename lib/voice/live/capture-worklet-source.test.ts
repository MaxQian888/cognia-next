import { CAPTURE_PROCESSOR_NAME, buildCaptureWorkletSource } from "./capture-worklet-source"

interface PostedFrame {
  type: string
  samples: Float32Array
  rms: number
}

interface LoadedProcessor {
  name: string
  process(inputs: Float32Array[][]): boolean
  send(message: unknown): void
  frames(): PostedFrame[]
  transfers(): unknown[][]
}

/**
 * Evaluate the worklet source against stubbed AudioWorklet globals and return a
 * driver for the registered processor.
 *
 * The source ships as a string that only ever runs inside a real AudioWorklet
 * scope, so evaluating it here is the only way to cover the framing arithmetic
 * without duplicating it in the test.
 */
function loadProcessor(frameSamples: number): LoadedProcessor {
  const posted: PostedFrame[] = []
  const transfers: unknown[][] = []

  class FakeAudioWorkletProcessor {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: PostedFrame, transfer: unknown[] = []) => {
        // Structured-clone transfer does not happen in this harness, so copy the
        // samples to mimic the detach the real runtime performs.
        posted.push({ ...message, samples: Float32Array.from(message.samples) })
        transfers.push(transfer)
      },
    }
  }

  let registeredName = ""
  let Ctor: (new () => { port: FakeAudioWorkletProcessor["port"] }) | undefined
  const registerProcessor = (name: string, ctor: new () => never) => {
    registeredName = name
    Ctor = ctor as unknown as new () => { port: FakeAudioWorkletProcessor["port"] }
  }

  new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    buildCaptureWorkletSource({ frameSamples })
  )(FakeAudioWorkletProcessor, registerProcessor)

  if (!Ctor) throw new Error("worklet source did not register a processor")
  const instance = new Ctor() as { port: FakeAudioWorkletProcessor["port"] } & {
    process(inputs: Float32Array[][]): boolean
  }

  return {
    name: registeredName,
    process: (inputs) => instance.process(inputs),
    send: (message) => instance.port.onmessage?.({ data: message }),
    frames: () => posted,
    transfers: () => transfers,
  }
}

/** One render quantum's worth of input, shaped as the worklet receives it. */
function input(samples: number[]): Float32Array[][] {
  return [[new Float32Array(samples)]]
}

describe("buildCaptureWorkletSource", () => {
  it("rejects a non-positive or non-integer frame size", () => {
    expect(() => buildCaptureWorkletSource({ frameSamples: 0 })).toThrow(/positive integer/)
    expect(() => buildCaptureWorkletSource({ frameSamples: 2.5 })).toThrow(/positive integer/)
  })

  it("registers under the shared processor name", () => {
    expect(loadProcessor(4).name).toBe(CAPTURE_PROCESSOR_NAME)
  })

  it("embeds the requested frame size", () => {
    expect(buildCaptureWorkletSource({ frameSamples: 480 })).toContain("this.frameSamples = 480")
  })
})

describe("capture processor", () => {
  it("emits nothing until a whole frame is buffered", () => {
    const worklet = loadProcessor(4)

    expect(worklet.process(input([1, 2]))).toBe(true)

    expect(worklet.frames()).toHaveLength(0)
  })

  it("emits one frame once the quanta complete it", () => {
    const worklet = loadProcessor(4)
    worklet.process(input([1, 2]))
    worklet.process(input([3, 4]))

    expect(worklet.frames()).toHaveLength(1)
    expect(Array.from(worklet.frames()[0].samples)).toEqual([1, 2, 3, 4])
    expect(worklet.frames()[0].type).toBe("frame")
  })

  it("splits an oversized quantum into whole frames and keeps the remainder", () => {
    const worklet = loadProcessor(2)

    worklet.process(input([1, 2, 3, 4, 5]))

    expect(worklet.frames().map((frame) => Array.from(frame.samples))).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it("preserves sample order across many uneven quanta", () => {
    const worklet = loadProcessor(3)
    for (const chunk of [[1], [2, 3, 4], [5, 6, 7, 8, 9]]) worklet.process(input(chunk))

    expect(worklet.frames().flatMap((frame) => Array.from(frame.samples))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
  })

  it("transfers the frame buffer instead of copying it", () => {
    const worklet = loadProcessor(2)

    worklet.process(input([1, 2]))

    expect(worklet.transfers()[0]).toHaveLength(1)
  })

  it("allocates a fresh buffer per frame so a transferred one is never reused", () => {
    const worklet = loadProcessor(2)

    worklet.process(input([1, 2, 3, 4]))

    const [first, second] = worklet.frames()
    expect(Array.from(first.samples)).toEqual([1, 2])
    expect(Array.from(second.samples)).toEqual([3, 4])
  })

  it("reports RMS alongside the frame", () => {
    const worklet = loadProcessor(4)

    worklet.process(input([1, -1, 1, -1]))

    expect(worklet.frames()[0].rms).toBeCloseTo(1, 10)
  })

  it("reports zero RMS for silence", () => {
    const worklet = loadProcessor(4)

    worklet.process(input([0, 0, 0, 0]))

    expect(worklet.frames()[0].rms).toBe(0)
  })

  it("stays alive when the node has no input yet", () => {
    const worklet = loadProcessor(4)

    expect(worklet.process([])).toBe(true)
    expect(worklet.process([[]])).toBe(true)
    expect(worklet.process(input([]))).toBe(true)
    expect(worklet.frames()).toHaveLength(0)
  })

  describe("mute", () => {
    it("emits nothing while muted but keeps the graph running", () => {
      const worklet = loadProcessor(2)
      worklet.send({ type: "mute", muted: true })

      expect(worklet.process(input([1, 2]))).toBe(true)
      expect(worklet.frames()).toHaveLength(0)
    })

    it("drops the partial frame so no half utterance is committed on unmute", () => {
      const worklet = loadProcessor(4)
      worklet.process(input([1, 2]))
      worklet.send({ type: "mute", muted: true })
      worklet.process(input([3]))
      worklet.send({ type: "mute", muted: false })

      worklet.process(input([9, 9, 9, 9]))

      expect(worklet.frames().map((frame) => Array.from(frame.samples))).toEqual([[9, 9, 9, 9]])
    })

    it("resumes emitting after unmute", () => {
      const worklet = loadProcessor(2)
      worklet.send({ type: "mute", muted: true })
      worklet.process(input([1, 2]))
      worklet.send({ type: "mute", muted: false })

      worklet.process(input([3, 4]))

      expect(worklet.frames()).toHaveLength(1)
    })
  })

  describe("reset", () => {
    it("discards buffered samples without emitting them", () => {
      const worklet = loadProcessor(4)
      worklet.process(input([1, 2, 3]))

      worklet.send({ type: "reset" })
      worklet.process(input([5, 6, 7, 8]))

      expect(worklet.frames().map((frame) => Array.from(frame.samples))).toEqual([[5, 6, 7, 8]])
    })
  })

  it("ignores malformed control messages", () => {
    const worklet = loadProcessor(2)

    expect(() => {
      worklet.send(null)
      worklet.send(undefined)
      worklet.send({ type: "unknown" })
    }).not.toThrow()

    worklet.process(input([1, 2]))
    expect(worklet.frames()).toHaveLength(1)
  })
})
