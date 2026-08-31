import { act, renderHook } from "@testing-library/react"

import { useCopy } from "./use-copy"

describe("useCopy", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: jest.fn(async () => undefined) },
    })
  })

  afterEach(() => jest.useRealTimers())

  it("copies and resets its feedback state", async () => {
    const { result, unmount } = renderHook(() => useCopy({ resetMs: 100 }))
    await act(async () => {
      await expect(result.current.copy("hello")).resolves.toBe(true)
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello")
    expect(result.current.copied).toBe(true)
    act(() => jest.advanceTimersByTime(100))
    expect(result.current.copied).toBe(false)
    unmount()
  })

  it("reports clipboard failures without throwing", async () => {
    const error = new Error("denied")
    ;(navigator.clipboard.writeText as jest.Mock).mockRejectedValueOnce(error)
    const logger = { warn: jest.fn() }
    const { result } = renderHook(() => useCopy({ logger, scope: "card" }))
    await act(async () => {
      await expect(result.current.copy("hello")).resolves.toBe(false)
    })
    expect(logger.warn).toHaveBeenCalledWith("card clipboard write failed", { error: "denied" })
    expect(result.current.isCopying).toBe(false)
  })
})
