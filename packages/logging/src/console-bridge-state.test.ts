import { CONSOLE_BRIDGE_ORIGINALS, getOriginalConsoleMethod } from "./console-bridge-state"

describe("console bridge original method lookup", () => {
  it("falls back to the current bound console method", () => {
    const calls: unknown[][] = []
    const target = {
      warn(this: unknown, ...args: unknown[]) {
        expect(this).toBe(target)
        calls.push(args)
      },
    } as unknown as Console

    getOriginalConsoleMethod(target, "warn")("fallback")

    expect(calls).toEqual([["fallback"]])
  })

  it("uses stored originals for bridged warn and error methods", () => {
    const originalWarn = jest.fn()
    const originalError = jest.fn()
    const target = {
      warn: jest.fn(),
      error: jest.fn(),
      [CONSOLE_BRIDGE_ORIGINALS]: { warn: originalWarn, error: originalError },
    } as unknown as Console

    getOriginalConsoleMethod(target, "warn")("warning")
    getOriginalConsoleMethod(target, "error")("failure")

    expect(originalWarn).toHaveBeenCalledWith("warning")
    expect(originalError).toHaveBeenCalledWith("failure")
    expect(target.warn).not.toHaveBeenCalled()
    expect(target.error).not.toHaveBeenCalled()
  })

  it("does not substitute stored warn/error methods for other levels", () => {
    const info = jest.fn()
    const target = {
      info,
      warn: jest.fn(),
      error: jest.fn(),
      [CONSOLE_BRIDGE_ORIGINALS]: { warn: jest.fn(), error: jest.fn() },
    } as unknown as Console

    getOriginalConsoleMethod(target, "info")("status")

    expect(info).toHaveBeenCalledWith("status")
  })
})
