import { emitCredentialsRotated, onCredentialsRotated } from "./credentials-events"

describe("credentials-events", () => {
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
