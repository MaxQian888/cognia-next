import { everyBudget, mapBounded, yieldToMain } from "./pacing"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("mapBounded", () => {
  it("preserves input order", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i)
    const out = await mapBounded(items, 4, async (item) => {
      // Lanes finish out of order on purpose — results must land by index,
      // not by completion order.
      await new Promise((resolve) => setTimeout(resolve, (items.length - item) % 3))
      return item * 2
    })
    expect(out).toEqual(items.map((i) => i * 2))
  })

  it("never exceeds the in-flight limit", async () => {
    const items = Array.from({ length: 12 }, (_, i) => i)
    let inFlight = 0
    let max = 0
    await mapBounded(items, 3, async () => {
      inFlight += 1
      max = Math.max(max, inFlight)
      await tick()
      inFlight -= 1
    })
    expect(max).toBe(3)
  })

  it("runs serially when the limit is 1 (and treats 0 as 1)", async () => {
    const items = [1, 2, 3, 4]
    let inFlight = 0
    let max = 0
    await mapBounded(items, 0, async () => {
      inFlight += 1
      max = Math.max(max, inFlight)
      await tick()
      inFlight -= 1
    })
    expect(max).toBe(1)
  })

  it("resolves an empty list", async () => {
    await expect(mapBounded([], 8, async () => 1)).resolves.toEqual([])
  })

  it("propagates item failures", async () => {
    await expect(
      mapBounded([1], 1, async () => {
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
  })
})

describe("yieldToMain / everyBudget", () => {
  afterEach(() => jest.useRealTimers())

  it("schedules a macrotask yield when the budget is exhausted", async () => {
    jest.useFakeTimers()
    const budget = everyBudget(0) // 0ms budget → every call yields
    const pending = budget()
    // Node has no scheduler.yield → the fallback queued a zero-timeout.
    expect(jest.getTimerCount()).toBeGreaterThan(0)
    jest.runAllTimers()
    await pending
  })

  it("does not yield inside the budget window", async () => {
    jest.useFakeTimers()
    const budget = everyBudget(Number.MAX_SAFE_INTEGER)
    await budget()
    expect(jest.getTimerCount()).toBe(0)
  })

  it("yieldToMain resolves on the fallback path", async () => {
    await expect(yieldToMain()).resolves.toBeUndefined()
  })
})
