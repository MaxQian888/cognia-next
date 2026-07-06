/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const capWriteText = jest.fn()
jest.mock("@/lib/capacitor/clipboard", () => ({
  writeText: (value: string) => capWriteText(value),
}))

import { useCopy } from "./use-copy"

describe("useCopy", () => {
  let originalClipboard: typeof navigator.clipboard | undefined
  let writeText: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    capWriteText.mockClear()
    capWriteText.mockResolvedValue({ kind: "unsupported" })
    originalClipboard = navigator.clipboard
    writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      })
    }
  })

  it("writes to clipboard and toggles copied flag, then resets after the configured delay", async () => {
    const { result } = renderHook(() => useCopy({ resetMs: 500 }))

    await act(async () => {
      const ok = await result.current.copy("hello")
      expect(ok).toBe(true)
    })

    expect(writeText).toHaveBeenCalledWith("hello")
    expect(result.current.copied).toBe(true)

    act(() => {
      jest.advanceTimersByTime(500)
    })
    expect(result.current.copied).toBe(false)
  })

  it("uses the native Capacitor clipboard on mobile without touching navigator", async () => {
    capWriteText.mockResolvedValueOnce({ kind: "ok" })
    const { result } = renderHook(() => useCopy())
    await act(async () => {
      const ok = await result.current.copy("native")
      expect(ok).toBe(true)
    })
    expect(capWriteText).toHaveBeenCalledWith("native")
    expect(writeText).not.toHaveBeenCalled()
    expect(result.current.copied).toBe(true)
  })

  it("accepts a numeric arg as the legacy resetMs shortcut", async () => {
    const { result } = renderHook(() => useCopy(250))
    await act(async () => {
      await result.current.copy("x")
    })
    expect(result.current.copied).toBe(true)
    act(() => {
      jest.advanceTimersByTime(250)
    })
    expect(result.current.copied).toBe(false)
  })

  it("falls back to execCommand when navigator.clipboard is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
    const exec = jest.fn(() => true)
    const realExec = document.execCommand
    document.execCommand = exec as unknown as typeof document.execCommand

    const { result } = renderHook(() => useCopy())
    await act(async () => {
      const ok = await result.current.copy("legacy")
      expect(ok).toBe(true)
    })
    expect(exec).toHaveBeenCalledWith("copy")
    document.execCommand = realExec
  })

  it("logs through the provided logger and returns false on write failure", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"))
    const warn = jest.fn()
    const { result } = renderHook(() => useCopy({ logger: { warn }, scope: "chat" }))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.copy("x")
    })
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledWith("chat clipboard write failed", { err: "denied" })
    expect(result.current.copied).toBe(false)
  })

  it("clears any pending reset timer when copy is called again", async () => {
    const { result } = renderHook(() => useCopy({ resetMs: 1000 }))
    await act(async () => {
      await result.current.copy("a")
    })
    act(() => {
      jest.advanceTimersByTime(500)
    })
    await act(async () => {
      await result.current.copy("b")
    })
    expect(result.current.copied).toBe(true)
    act(() => {
      jest.advanceTimersByTime(500)
    })
    expect(result.current.copied).toBe(true)
    act(() => {
      jest.advanceTimersByTime(500)
    })
    expect(result.current.copied).toBe(false)
  })
})
