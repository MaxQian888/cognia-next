import { safeUnlisten } from "./safe-unlisten"

describe("safeUnlisten", () => {
  it("is a no-op for null / undefined", () => {
    expect(() => safeUnlisten(null)).not.toThrow()
    expect(() => safeUnlisten(undefined)).not.toThrow()
  })

  it("invokes a synchronous unlisten exactly once", () => {
    const fn = jest.fn()
    safeUnlisten(fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("swallows a synchronous throw from unlisten", () => {
    const fn = jest.fn(() => {
      throw new Error("listeners[eventId] is undefined")
    })
    expect(() => safeUnlisten(fn)).not.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("swallows a rejected-promise unlisten without surfacing an unhandled rejection", async () => {
    const onUnhandled = jest.fn()
    process.on("unhandledRejection", onUnhandled)
    try {
      const fn = jest.fn(() => Promise.reject(new TypeError("listeners[eventId].handlerId")))
      expect(() => safeUnlisten(fn)).not.toThrow()
      expect(fn).toHaveBeenCalledTimes(1)
      // Flush the microtask queue + a macrotask so any unhandled rejection fires.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("ignores a resolved-promise unlisten", async () => {
    const fn = jest.fn(() => Promise.resolve())
    expect(() => safeUnlisten(fn)).not.toThrow()
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
