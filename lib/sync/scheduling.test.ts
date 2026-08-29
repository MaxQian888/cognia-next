import { applyInSlices, chunk, whenIdle, yieldToMain } from "./scheduling"

/**
 * The DOM lib types `scheduler` and `requestIdleCallback` as non-optional
 * members of `Window`, so a test that installs or removes them has to talk to
 * the global as a plain bag of properties.
 */
const g = globalThis as unknown as {
  scheduler?: { yield?: () => Promise<void> }
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
}

describe("chunk", () => {
  it("returns the input array itself when it already fits", () => {
    const rows = [1, 2, 3]
    expect(chunk(rows, 5)[0]).toBe(rows)
    expect(chunk(rows, 3)[0]).toBe(rows)
  })

  it("splits into slices of at most size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it("treats a non-positive size as no chunking rather than looping forever", () => {
    const rows = [1, 2, 3]
    expect(chunk(rows, 0)[0]).toBe(rows)
    expect(chunk(rows, -1)[0]).toBe(rows)
  })

  it("returns one empty slice for no rows", () => {
    expect(chunk([], 10)).toEqual([[]])
  })
})

describe("yieldToMain", () => {
  afterEach(() => {
    delete g.scheduler
  })

  it("prefers scheduler.yield when the platform has it", async () => {
    const yieldFn = jest.fn().mockResolvedValue(undefined)
    g.scheduler = { yield: yieldFn }

    await yieldToMain()

    expect(yieldFn).toHaveBeenCalledTimes(1)
  })

  it("still yields when scheduler.yield rejects", async () => {
    // An aborted task signal rejects the yield. The pull must continue: the
    // point is to hand the thread back, not to hand it back a particular way.
    g.scheduler = { yield: jest.fn().mockRejectedValue(new Error("aborted")) }

    await expect(yieldToMain()).resolves.toBeUndefined()
  })

  it("resolves without a scheduler at all", async () => {
    await expect(yieldToMain()).resolves.toBeUndefined()
  })
})

describe("whenIdle", () => {
  afterEach(() => {
    delete g.requestIdleCallback
  })

  it("passes a deadline so a busy or hidden tab still drains", async () => {
    const idle = jest.fn((cb: () => void) => {
      cb()
      return 1
    })
    g.requestIdleCallback = idle

    await whenIdle(1234)

    expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 1234 })
  })

  it("falls back to a macrotask where requestIdleCallback does not exist", async () => {
    await expect(whenIdle(10)).resolves.toBeUndefined()
  })

  it("resolves promptly under jsdom rather than waiting on a port message", async () => {
    // Regression guard for the MessageChannel path this module deliberately
    // does not take: jsdom delivers port messages at ~600 ms apiece after the
    // first, which turned a 100-page drain into a test-suite timeout.
    const started = Date.now()
    for (let i = 0; i < 20; i++) await yieldToMain()
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe("applyInSlices", () => {
  it("applies nothing and never yields for an empty input", async () => {
    const apply = jest.fn()
    await applyInSlices([], 10, apply)
    expect(apply).not.toHaveBeenCalled()
  })

  it("applies a single slice without yielding", async () => {
    const yieldFn = jest.fn().mockResolvedValue(undefined)
    g.scheduler = { yield: yieldFn }
    const apply = jest.fn().mockResolvedValue(undefined)

    await applyInSlices([1, 2], 10, apply)

    expect(apply).toHaveBeenCalledTimes(1)
    expect(yieldFn).not.toHaveBeenCalled()
    delete g.scheduler
  })

  it("yields between slices but not after the last one", async () => {
    const yieldFn = jest.fn().mockResolvedValue(undefined)
    g.scheduler = { yield: yieldFn }
    const seen: number[][] = []

    await applyInSlices([1, 2, 3, 4, 5], 2, async (slice) => {
      seen.push([...slice])
    })

    expect(seen).toEqual([[1, 2], [3, 4], [5]])
    expect(yieldFn).toHaveBeenCalledTimes(2)
    delete g.scheduler
  })

  it("propagates an apply failure instead of swallowing it", async () => {
    await expect(
      applyInSlices([1, 2, 3], 2, async (slice) => {
        if (slice.includes(3)) throw new Error("dexie refused")
      })
    ).rejects.toThrow("dexie refused")
  })
})
