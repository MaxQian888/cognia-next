import { createStreamSink } from "./stream-sink"

describe("createStreamSink", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  function makeLogger() {
    const calls: Array<{ stepId: string; delta: string; seq: number }> = []
    return {
      calls,
      logger: {
        stepStream: jest.fn((stepId: string, delta: string, seq: number) => {
          calls.push({ stepId, delta, seq })
          return Promise.resolve()
        }),
      },
    }
  }

  it("buffers deltas and flushes once after flushMs", () => {
    const { logger, calls } = makeLogger()
    const sink = createStreamSink({ stepId: "n1", logger, flushMs: 100 })

    sink.push("Hel")
    sink.push("lo ")
    sink.push("world")
    expect(calls).toHaveLength(0)

    jest.advanceTimersByTime(100)
    expect(calls).toEqual([{ stepId: "n1", delta: "Hello world", seq: 0 }])
  })

  it("flushes immediately when the buffer exceeds maxBufferChars", () => {
    const { logger, calls } = makeLogger()
    const sink = createStreamSink({
      stepId: "n1",
      logger,
      flushMs: 10_000,
      maxBufferChars: 5,
    })

    sink.push("abcdef") // 6 > 5 → immediate flush, no timer wait
    expect(calls).toEqual([{ stepId: "n1", delta: "abcdef", seq: 0 }])
  })

  it("assigns monotonically increasing seq across flushes", () => {
    const { logger, calls } = makeLogger()
    const sink = createStreamSink({ stepId: "n1", logger, flushMs: 50 })

    sink.push("a")
    jest.advanceTimersByTime(50)
    sink.push("b")
    jest.advanceTimersByTime(50)
    sink.push("c")
    jest.advanceTimersByTime(50)

    expect(calls.map((c) => c.seq)).toEqual([0, 1, 2])
    expect(calls.map((c) => c.delta)).toEqual(["a", "b", "c"])
  })

  it("final() flushes the remaining buffer and cancels the timer", () => {
    const { logger, calls } = makeLogger()
    const sink = createStreamSink({ stepId: "n1", logger, flushMs: 1000 })

    sink.push("tail")
    sink.final()
    expect(calls).toEqual([{ stepId: "n1", delta: "tail", seq: 0 }])

    // Timer must be dead — advancing time produces no duplicate write.
    jest.advanceTimersByTime(5000)
    expect(calls).toHaveLength(1)
  })

  it("final() is idempotent and drops pushes after close", () => {
    const { logger, calls } = makeLogger()
    const sink = createStreamSink({ stepId: "n1", logger, flushMs: 100 })

    sink.push("x")
    sink.final()
    sink.final()
    sink.push("ignored")
    jest.advanceTimersByTime(1000)

    expect(calls).toEqual([{ stepId: "n1", delta: "x", seq: 0 }])
  })

  it("final() with an empty buffer writes nothing", () => {
    const { logger, calls } = makeLogger()
    const sink = createStreamSink({ stepId: "n1", logger, flushMs: 100 })

    sink.final()
    expect(calls).toHaveLength(0)
  })

  it("flush() on demand writes buffered content without waiting", () => {
    const { logger, calls } = makeLogger()
    const sink = createStreamSink({ stepId: "n1", logger, flushMs: 10_000 })

    sink.push("now")
    sink.flush()
    expect(calls).toEqual([{ stepId: "n1", delta: "now", seq: 0 }])

    // Empty flush is a no-op.
    sink.flush()
    expect(calls).toHaveLength(1)
  })

  it("ignores empty deltas", () => {
    const { logger, calls } = makeLogger()
    const sink = createStreamSink({ stepId: "n1", logger, flushMs: 100 })

    sink.push("")
    jest.advanceTimersByTime(1000)
    expect(calls).toHaveLength(0)
  })
})
