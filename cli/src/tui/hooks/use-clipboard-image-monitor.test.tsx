import { act, renderHook } from "@testing-library/react"

import { CLIPBOARD_IMAGE_POLL_MS, useClipboardImageMonitor } from "./use-clipboard-image-monitor"

const tick = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms)
    await Promise.resolve()
  })
}

describe("useClipboardImageMonitor", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("probes immediately and reports true when the clipboard holds an image", async () => {
    const probe = jest.fn(async () => true)
    const { result } = renderHook(() => useClipboardImageMonitor({ probe }))
    await act(async () => Promise.resolve())
    expect(result.current).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("reports false and keeps polling when the clipboard holds no image", async () => {
    const probe = jest.fn(async () => false)
    const { result } = renderHook(() => useClipboardImageMonitor({ probe }))
    await act(async () => Promise.resolve())
    expect(result.current).toBe(false)
    await tick(CLIPBOARD_IMAGE_POLL_MS)
    await tick(CLIPBOARD_IMAGE_POLL_MS)
    expect(probe).toHaveBeenCalledTimes(3)
    expect(result.current).toBe(false)
  })

  it("reflects the clipboard changing between polls", async () => {
    let image = false
    const probe = jest.fn(async () => image)
    const { result } = renderHook(() => useClipboardImageMonitor({ probe }))
    await act(async () => Promise.resolve())
    expect(result.current).toBe(false)
    image = true
    await tick(CLIPBOARD_IMAGE_POLL_MS)
    expect(result.current).toBe(true)
    image = false
    await tick(CLIPBOARD_IMAGE_POLL_MS)
    expect(result.current).toBe(false)
  })

  it("never overlaps probes — a slow check skips the next interval", async () => {
    let finish: (v: boolean) => void = () => {}
    const probe = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
    const { result } = renderHook(() => useClipboardImageMonitor({ probe }))
    await act(async () => Promise.resolve())
    expect(probe).toHaveBeenCalledTimes(1)
    // The interval fires while the first probe is still in flight → skipped.
    await tick(CLIPBOARD_IMAGE_POLL_MS * 2)
    expect(probe).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish(true)
      await Promise.resolve()
    })
    expect(result.current).toBe(true)
    await tick(CLIPBOARD_IMAGE_POLL_MS)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("treats a rejecting probe as no-image and keeps polling", async () => {
    const probe = jest.fn(async () => {
      throw new Error("clipboard busy")
    })
    const { result } = renderHook(() => useClipboardImageMonitor({ probe }))
    await act(async () => Promise.resolve())
    expect(result.current).toBe(false)
    await tick(CLIPBOARD_IMAGE_POLL_MS)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("does nothing without a probe and stops while inactive", async () => {
    const probe = jest.fn(async () => true)
    const { result, rerender } = renderHook(
      ({ active }) => useClipboardImageMonitor({ probe, active }),
      { initialProps: { active: false } }
    )
    await tick(CLIPBOARD_IMAGE_POLL_MS * 3)
    expect(probe).not.toHaveBeenCalled()
    expect(result.current).toBe(false)

    rerender({ active: true })
    await act(async () => Promise.resolve())
    expect(probe).toHaveBeenCalledTimes(1)
    expect(result.current).toBe(true)

    // Deactivating masks the last result immediately and stops the loop.
    rerender({ active: false })
    expect(result.current).toBe(false)
    const calls = probe.mock.calls.length
    await tick(CLIPBOARD_IMAGE_POLL_MS * 3)
    expect(probe).toHaveBeenCalledTimes(calls)
  })

  it("runs no timer at all when the probe is absent", async () => {
    const { result } = renderHook(() => useClipboardImageMonitor({}))
    await tick(CLIPBOARD_IMAGE_POLL_MS * 3)
    expect(result.current).toBe(false)
  })

  it("cleans up on unmount", async () => {
    const probe = jest.fn(async () => true)
    const { unmount } = renderHook(() => useClipboardImageMonitor({ probe }))
    await act(async () => Promise.resolve())
    unmount()
    await tick(CLIPBOARD_IMAGE_POLL_MS * 3)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
