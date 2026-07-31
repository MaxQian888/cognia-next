import { runWithConcurrency } from "@/lib/plugin/core/concurrency"

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe("runWithConcurrency", () => {
  it("processes every item and passes the index", async () => {
    const seen: Array<[number, number]> = []
    await runWithConcurrency([10, 20, 30], 2, async (item, index) => {
      seen.push([item, index])
    })
    expect(seen.sort((a, b) => a[1] - b[1])).toEqual([
      [10, 0],
      [20, 1],
      [30, 2],
    ])
  })

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0
    let peak = 0
    const gates = Array.from({ length: 6 }, () => deferred<void>())
    const items = gates.map((_, i) => i)

    const run = runWithConcurrency(items, 2, async (i) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await gates[i].promise
      inFlight--
    })

    // Release sequentially so the pool keeps refilling.
    for (let i = 0; i < gates.length; i++) {
      await Promise.resolve()
      gates[i].resolve()
    }
    await run
    expect(peak).toBeLessThanOrEqual(2)
  })

  it("returns immediately for an empty list", async () => {
    const worker = jest.fn()
    await runWithConcurrency([], 4, worker)
    expect(worker).not.toHaveBeenCalled()
  })

  it("caps the pool size to the item count", async () => {
    let peak = 0
    let inFlight = 0
    await runWithConcurrency([1], 8, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight--
    })
    expect(peak).toBe(1)
  })

  it("propagates a worker rejection", async () => {
    await expect(
      runWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("worker boom")
      })
    ).rejects.toThrow("worker boom")
  })
})
