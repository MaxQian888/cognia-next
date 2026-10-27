/** @jest-environment jsdom */

import {
  __resetCredentialsEventsForTesting,
  emitCredentialsRotated,
  getCredentialsGeneration,
  onCredentialsRotated,
} from "./credentials-events"

describe("credentials-events", () => {
  beforeEach(() => {
    localStorage.clear()
    __resetCredentialsEventsForTesting()
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("advances an adapter revision even when rotations share a timestamp", () => {
    jest.spyOn(Date, "now").mockReturnValue(1000)
    const before = getCredentialsGeneration("avatar-revision")
    emitCredentialsRotated("avatar-revision")
    const first = getCredentialsGeneration("avatar-revision")
    emitCredentialsRotated("avatar-revision")
    expect(first).not.toBe(before)
    expect(getCredentialsGeneration("avatar-revision")).not.toBe(first)
    expect(getCredentialsGeneration("unrelated-avatar-adapter")).toBe("0")
  })

  it("assigns distinct revisions when independent windows read the same old value", () => {
    jest.spyOn(Date, "now").mockReturnValue(1000)
    // Simulate a second renderer that read the same pre-save storage snapshot.
    jest.spyOn(Storage.prototype, "getItem").mockReturnValue(null)
    emitCredentialsRotated("avatar-simultaneous-save")
    const first = getCredentialsGeneration("avatar-simultaneous-save")
    __resetCredentialsEventsForTesting()
    emitCredentialsRotated("avatar-simultaneous-save")
    const second = getCredentialsGeneration("avatar-simultaneous-save")
    expect(second).not.toBe(first)
    expect(second).not.toBe("0")
  })

  it("retains a nonsecret revision across renderer reloads", () => {
    emitCredentialsRotated("avatar-reload")
    const generation = getCredentialsGeneration("avatar-reload")
    __resetCredentialsEventsForTesting()
    expect(getCredentialsGeneration("avatar-reload")).toBe(generation)
    expect(generation).toBe(
      `0:${localStorage.getItem("cognia:connectors:credentials-revision:avatar-reload")}`
    )
  })

  it("notifies every listener once for a rotation from another window", () => {
    const a = jest.fn()
    const b = jest.fn()
    const unA = onCredentialsRotated(a)
    const unB = onCredentialsRotated(b)
    const key = "cognia:connectors:credentials-revision:avatar-other-window"
    const generation = crypto.randomUUID()
    localStorage.setItem(key, String(generation))
    // React may read its snapshot before the queued storage event is delivered.
    expect(getCredentialsGeneration("avatar-other-window")).toBe(`0:${generation}`)
    const event = () => new StorageEvent("storage", { key, newValue: String(generation) })
    window.dispatchEvent(event())
    window.dispatchEvent(event())
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "avatar-other-window" }))
    unA()
    unB()
    const nextGeneration = crypto.randomUUID()
    localStorage.setItem(key, nextGeneration)
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: nextGeneration }))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it("keeps local rotation working when persistence is unavailable", () => {
    const get = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable")
    })
    const set = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("unavailable")
    })
    const handler = jest.fn()
    const unsubscribe = onCredentialsRotated(handler)
    emitCredentialsRotated("avatar-unavailable-storage")
    expect(getCredentialsGeneration("avatar-unavailable-storage")).not.toBe("0")
    expect(handler).toHaveBeenCalledTimes(1)
    unsubscribe()
    get.mockRestore()
    set.mockRestore()
  })

  it("does not restore the persisted old revision after a quota failure", () => {
    emitCredentialsRotated("avatar-storage-full")
    const previous = getCredentialsGeneration("avatar-storage-full")
    const stored = localStorage.getItem(
      "cognia:connectors:credentials-revision:avatar-storage-full"
    )
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    emitCredentialsRotated("avatar-storage-full")
    const current = getCredentialsGeneration("avatar-storage-full")
    expect(current).not.toBe(previous)
    expect(getCredentialsGeneration("avatar-storage-full")).toBe(current)
    expect(localStorage.getItem("cognia:connectors:credentials-revision:avatar-storage-full")).toBe(
      stored
    )
  })

  it("does not adopt an unseen old revision when blocked storage becomes readable again", () => {
    const key = "cognia:connectors:credentials-revision:avatar-storage-recovered"
    const old = crypto.randomUUID()
    localStorage.setItem(key, old)
    __resetCredentialsEventsForTesting()
    const get = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable")
    })
    const set = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("unavailable")
    })
    emitCredentialsRotated("avatar-storage-recovered")
    const blocked = getCredentialsGeneration("avatar-storage-recovered")
    get.mockRestore()
    set.mockRestore()
    const recovered = getCredentialsGeneration("avatar-storage-recovered")
    expect(recovered).not.toBe(`0:${old}`)
    expect(recovered.split(":")[0]).toBe(blocked.split(":")[0])
    const remote = crypto.randomUUID()
    localStorage.setItem(key, remote)
    expect(getCredentialsGeneration("avatar-storage-recovered")).not.toBe(recovered)
  })
  it("invokes registered handlers with adapterId + timestamp", () => {
    const handler = jest.fn()
    const unsubscribe = onCredentialsRotated(handler)
    const before = Date.now()
    emitCredentialsRotated("lark-work")
    const after = Date.now()
    expect(handler).toHaveBeenCalledTimes(1)
    const detail = handler.mock.calls[0][0] as { adapterId: string; rotatedAt: number }
    expect(detail.adapterId).toBe("lark-work")
    expect(detail.rotatedAt).toBeGreaterThanOrEqual(before)
    expect(detail.rotatedAt).toBeLessThanOrEqual(after)
    unsubscribe()
  })

  it("unsubscribes cleanly", () => {
    const handler = jest.fn()
    const unsubscribe = onCredentialsRotated(handler)
    unsubscribe()
    emitCredentialsRotated("slack-prod")
    expect(handler).not.toHaveBeenCalled()
  })

  it("silently ignores empty adapterId", () => {
    const handler = jest.fn()
    const unsubscribe = onCredentialsRotated(handler)
    emitCredentialsRotated("")
    expect(handler).not.toHaveBeenCalled()
    unsubscribe()
  })

  it("supports multiple concurrent listeners and isolates them", () => {
    const a = jest.fn()
    const b = jest.fn()
    const unA = onCredentialsRotated(a)
    const unB = onCredentialsRotated(b)
    emitCredentialsRotated("discord-test")
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    unA()
    emitCredentialsRotated("discord-test-2")
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    unB()
  })

  it("isolates handler exceptions from siblings", () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    const thrower = jest.fn(() => {
      throw new Error("boom")
    })
    const survivor = jest.fn()
    const unT = onCredentialsRotated(thrower)
    const unS = onCredentialsRotated(survivor)
    emitCredentialsRotated("telegram-x")
    expect(thrower).toHaveBeenCalledTimes(1)
    expect(survivor).toHaveBeenCalledTimes(1)
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
    unT()
    unS()
  })
})
