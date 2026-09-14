import {
  abortActiveScan,
  clearActiveScan,
  clearStrixRuntime,
  consumePendingTarget,
  getActiveScan,
  getStrixRuntime,
  peekStrixRuntime,
  setActiveScan,
  setPendingTarget,
  setStrixRuntime,
} from "./runtime"

const fakeRuntime = () =>
  ({ terminal: {}, dexie: {}, securityScans: {} }) as Parameters<typeof setStrixRuntime>[0]

beforeEach(() => {
  clearStrixRuntime()
  clearActiveScan()
  consumePendingTarget()
})

describe("runtime bridge", () => {
  it("is null until wired, then throws only for the strict getter", () => {
    expect(peekStrixRuntime()).toBeNull()
    expect(() => getStrixRuntime()).toThrow(/not initialized/)

    const rt = fakeRuntime()
    setStrixRuntime(rt)
    expect(peekStrixRuntime()).toBe(rt)
    expect(getStrixRuntime()).toBe(rt)

    clearStrixRuntime()
    expect(peekStrixRuntime()).toBeNull()
  })
})

describe("active scan registry", () => {
  it("tracks the in-flight scan so a remounted panel can still abort it", () => {
    const controller = new AbortController()
    setActiveScan("run-1", controller)
    expect(getActiveScan()).toEqual({ runId: "run-1", controller })

    abortActiveScan()
    expect(controller.signal.aborted).toBe(true)
  })

  it("clears by runId so a finished scan cannot evict a newer one", () => {
    setActiveScan("run-1", new AbortController())
    clearActiveScan("run-2") // different run — must not clear
    expect(getActiveScan()?.runId).toBe("run-1")

    clearActiveScan("run-1")
    expect(getActiveScan()).toBeNull()
  })

  it("clears unconditionally when no runId is given", () => {
    setActiveScan("run-1", new AbortController())
    clearActiveScan()
    expect(getActiveScan()).toBeNull()
  })

  it("tolerates an abort with nothing in flight", () => {
    expect(() => abortActiveScan()).not.toThrow()
  })
})

describe("pending target", () => {
  it("hands a /security <target> arg to exactly one consumer", () => {
    setPendingTarget("https://example.com")
    expect(consumePendingTarget()).toBe("https://example.com")
    // One-shot: the next consumer (a remounted panel) gets nothing.
    expect(consumePendingTarget()).toBeNull()
  })
})
