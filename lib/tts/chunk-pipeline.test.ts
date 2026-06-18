import { runChunkPipeline } from "@/lib/tts/chunk-pipeline"

/** A deferred promise we can resolve/reject from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("runChunkPipeline", () => {
  it("does nothing for an empty list", async () => {
    const produce = jest.fn()
    const consume = jest.fn()
    await runChunkPipeline({ count: 0, produce, consume, isCancelled: () => false, prefetch: true })
    expect(produce).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
  })

  it("serial mode produces and consumes strictly in order", async () => {
    const events: string[] = []
    await runChunkPipeline({
      count: 3,
      prefetch: false,
      isCancelled: () => false,
      produce: async (i) => {
        events.push(`produce:${i}`)
        return i
      },
      consume: async (item) => {
        events.push(`consume:${item}`)
      },
    })
    expect(events).toEqual([
      "produce:0",
      "consume:0",
      "produce:1",
      "consume:1",
      "produce:2",
      "consume:2",
    ])
  })

  it("prefetch starts produce(i+1) before consume(i) resolves", async () => {
    const order: string[] = []
    const consumeGate = deferred<void>()

    const run = runChunkPipeline<number>({
      count: 2,
      prefetch: true,
      isCancelled: () => false,
      produce: async (i) => {
        order.push(`produce:${i}`)
        return i
      },
      consume: async (item) => {
        order.push(`consume-start:${item}`)
        if (item === 0) await consumeGate.promise
        order.push(`consume-end:${item}`)
      },
    })

    // Let microtasks flush: produce(0) → consume(0) starts → produce(1) fired.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // produce(1) was issued while consume(0) is still blocked on the gate.
    expect(order).toContain("produce:1")
    expect(order).not.toContain("consume-end:0")

    consumeGate.resolve()
    await run
    expect(order).toEqual([
      "produce:0",
      "produce:1",
      "consume-start:0",
      "consume-end:0",
      "consume-start:1",
      "consume-end:1",
    ])
  })

  it("prefetch stops issuing produce once cancelled", async () => {
    let cancelled = false
    const produced: number[] = []
    await runChunkPipeline<number>({
      count: 5,
      prefetch: true,
      isCancelled: () => cancelled,
      produce: async (i) => {
        produced.push(i)
        return i
      },
      consume: async (item) => {
        if (item === 1) cancelled = true
      },
    })
    // Depth-1 prefetch always runs one synthesis ahead: produce(2) is issued
    // before consume(1) sets `cancelled`, so it can't be un-issued. The point
    // is that produce(3)/produce(4) never fire once cancellation is observed.
    expect(produced).toEqual([0, 1, 2])
  })

  it("serial mode stops at cancellation boundary", async () => {
    let cancelled = false
    const consumed: number[] = []
    await runChunkPipeline<number>({
      count: 4,
      prefetch: false,
      isCancelled: () => cancelled,
      produce: async (i) => i,
      consume: async (item) => {
        consumed.push(item)
        if (item === 0) cancelled = true
      },
    })
    expect(consumed).toEqual([0])
  })

  it("propagates a produce rejection (prefetch)", async () => {
    await expect(
      runChunkPipeline<number>({
        count: 2,
        prefetch: true,
        isCancelled: () => false,
        produce: async (i) => {
          if (i === 1) throw new Error("synth failed")
          return i
        },
        consume: async () => {},
      })
    ).rejects.toThrow("synth failed")
  })

  it("propagates a consume rejection (prefetch) and swallows the abandoned prefetch", async () => {
    await expect(
      runChunkPipeline<number>({
        count: 2,
        prefetch: true,
        isCancelled: () => false,
        produce: async (i) => i,
        consume: async (item) => {
          if (item === 0) throw new Error("playback failed")
        },
      })
    ).rejects.toThrow("playback failed")
  })
})
