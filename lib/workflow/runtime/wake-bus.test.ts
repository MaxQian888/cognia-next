import {
  _clearWakeBusForTest,
  _peekWakeKeys,
  cancelWake,
  emitWake,
  subscribeWake,
} from "./wake-bus"

afterEach(() => {
  _clearWakeBusForTest()
})

describe("wake-bus", () => {
  it("subscribe then emit resolves with the payload", async () => {
    const waitingPromise = subscribeWake("k1")
    expect(_peekWakeKeys()).toEqual(["k1"])
    const delivered = emitWake("k1", { source: "test", data: { hello: "world" } })
    expect(delivered).toBe(true)
    const payload = await waitingPromise
    expect(payload.source).toBe("test")
    expect(payload.data).toEqual({ hello: "world" })
    expect(typeof payload.emittedAt).toBe("number")
    expect(_peekWakeKeys()).toEqual([])
  })

  it("emit without a subscriber returns false", () => {
    expect(emitWake("missing", { source: "nope" })).toBe(false)
  })

  it("times out when no emit fires within the window", async () => {
    await expect(subscribeWake("slow", { timeoutMs: 10 })).rejects.toThrow(/timed out/)
    expect(_peekWakeKeys()).toEqual([])
  })

  it("rejects when the abort signal is already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(subscribeWake("aborted", { signal: ac.signal })).rejects.toThrow(/aborted/)
  })

  it("rejects when the abort signal fires mid-wait", async () => {
    const ac = new AbortController()
    const promise = subscribeWake("midflight", { signal: ac.signal })
    setTimeout(() => ac.abort(), 5)
    await expect(promise).rejects.toThrow(/aborted/)
  })

  it("a second subscriber supersedes the first", async () => {
    const first = subscribeWake("dup")
    const second = subscribeWake("dup")
    await expect(first).rejects.toThrow(/superseded/)
    emitWake("dup", { source: "later" })
    const payload = await second
    expect(payload.source).toBe("later")
  })

  it("cancelWake rejects an outstanding wait", async () => {
    const promise = subscribeWake("cancel-me")
    const ok = cancelWake("cancel-me", "no longer needed")
    expect(ok).toBe(true)
    await expect(promise).rejects.toThrow(/no longer needed/)
    // Second cancel is a no-op.
    expect(cancelWake("cancel-me")).toBe(false)
  })
})
