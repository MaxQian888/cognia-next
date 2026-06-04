import {
  ConcurrencyGate,
  getGlobalRunGate,
  __setGlobalRunGateForTesting,
} from "./run-concurrency-gate"

describe("ConcurrencyGate", () => {
  it("allows up to `limit` concurrent holders", async () => {
    const gate = new ConcurrencyGate(2)
    const r1 = await gate.acquire()
    const r2 = await gate.acquire()
    expect(gate.active).toBe(2)

    let third = false
    const p3 = gate.acquire().then((release) => {
      third = true
      return release
    })
    // Give the microtask queue a chance — the third acquire must still wait.
    await Promise.resolve()
    expect(third).toBe(false)

    r1()
    const r3 = await p3
    expect(third).toBe(true)
    expect(gate.active).toBe(2)
    r2()
    r3()
    expect(gate.active).toBe(0)
  })

  it("release is idempotent (double-release frees one slot only)", async () => {
    const gate = new ConcurrencyGate(1)
    const r1 = await gate.acquire()
    r1()
    r1()
    const r2 = await gate.acquire()
    expect(gate.active).toBe(1)
    r2()
  })

  it("processes the queue in FIFO order", async () => {
    const gate = new ConcurrencyGate(1)
    const order: number[] = []
    const r1 = await gate.acquire()
    const p2 = gate.acquire().then((r) => {
      order.push(2)
      r()
    })
    const p3 = gate.acquire().then((r) => {
      order.push(3)
      r()
    })
    r1()
    await Promise.all([p2, p3])
    expect(order).toEqual([2, 3])
  })

  it("rejects pending acquires when the signal aborts", async () => {
    const gate = new ConcurrencyGate(1)
    const r1 = await gate.acquire()
    const ac = new AbortController()
    const pending = gate.acquire(ac.signal)
    ac.abort()
    await expect(pending).rejects.toThrow(/abort/i)
    r1()
    // The aborted waiter must not have consumed the freed slot.
    const r2 = await gate.acquire()
    expect(gate.active).toBe(1)
    r2()
  })

  it("rejects immediately when the signal is already aborted", async () => {
    const gate = new ConcurrencyGate(1)
    const ac = new AbortController()
    ac.abort()
    await expect(gate.acquire(ac.signal)).rejects.toThrow(/abort/i)
  })
})

describe("getGlobalRunGate", () => {
  afterEach(() => __setGlobalRunGateForTesting(null))

  it("returns a singleton with the default limit of 16", () => {
    const g = getGlobalRunGate()
    expect(g.limit).toBe(16)
    expect(getGlobalRunGate()).toBe(g)
  })

  it("can be swapped for tests", () => {
    const custom = new ConcurrencyGate(2)
    __setGlobalRunGateForTesting(custom)
    expect(getGlobalRunGate()).toBe(custom)
  })
})
