import {
  MEMORY_FOLLOW_UP_SYNC_MS,
  __resetRemoteMemoryOutcomesForTests,
  remoteMemoryRefusal,
  settleRemoteMemoryMutation,
  subscribeRemoteMemoryRefusals,
  type SettleDeps,
} from "./remote-outcomes"

function deps(): SettleDeps & { scheduled: Array<{ run: () => void; ms: number }> } {
  const scheduled: Array<{ run: () => void; ms: number }> = []
  return {
    scheduled,
    rewind: jest.fn(),
    pull: jest.fn(async () => undefined),
    schedule: jest.fn((run: () => void, ms: number) => {
      const entry = { run, ms }
      scheduled.push(entry)
      return entry
    }),
    cancel: jest.fn(),
  }
}

beforeEach(() => __resetRemoteMemoryOutcomesForTests())

describe("remoteMemoryRefusal", () => {
  it("reads only ok:false answers, and names unknown reasons as a policy refusal", () => {
    expect(remoteMemoryRefusal({ ok: true, memoryId: "m1" })).toBeNull()
    expect(remoteMemoryRefusal(null)).toBeNull()
    expect(remoteMemoryRefusal("ok")).toBeNull()
    expect(remoteMemoryRefusal({ ok: false, reason: "unauthorized_namespace" })).toEqual({
      reason: "unauthorized_namespace",
    })
    expect(remoteMemoryRefusal({ ok: false, reason: "made_up" })).toEqual({
      reason: "policy_denied",
    })
  })
})

describe("settleRemoteMemoryMutation", () => {
  it("schedules one follow-up pull for an applied command, coalescing a burst", async () => {
    const d = deps()
    await settleRemoteMemoryMutation({ ok: true }, d)
    await settleRemoteMemoryMutation({ ok: true }, d)
    expect(d.cancel).toHaveBeenCalledTimes(1)
    expect(d.scheduled).toHaveLength(2)
    expect(d.scheduled[1].ms).toBe(MEMORY_FOLLOW_UP_SYNC_MS)
    d.scheduled[1].run()
    expect(d.pull).toHaveBeenCalledTimes(1)
    expect(d.rewind).not.toHaveBeenCalled()
  })

  it("rewinds, re-pulls and tells listeners when the host refuses", async () => {
    const d = deps()
    const listener = jest.fn()
    const stop = subscribeRemoteMemoryRefusals(listener)
    await settleRemoteMemoryMutation({ ok: false, reason: "not_found" }, d)
    expect(d.rewind).toHaveBeenCalledTimes(1)
    expect(d.pull).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ reason: "not_found" })
    stop()
    await settleRemoteMemoryMutation({ ok: false, reason: "not_found" }, d)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("cancels a scheduled pull when a refusal re-pulls immediately", async () => {
    const d = deps()
    await settleRemoteMemoryMutation({ ok: true }, d)
    await settleRemoteMemoryMutation({ ok: false, reason: "disabled" }, d)
    expect(d.cancel).toHaveBeenCalledWith(d.scheduled[0])
  })

  it("swallows a failing pull", async () => {
    const d = deps()
    ;(d.pull as jest.Mock).mockRejectedValueOnce(new Error("offline"))
    await expect(
      settleRemoteMemoryMutation({ ok: false, reason: "temporary" }, d)
    ).resolves.toBeUndefined()
  })
})
