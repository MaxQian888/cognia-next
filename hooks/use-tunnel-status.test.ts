/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import { useTunnelStatus } from "./use-tunnel-status"
import type { TunnelInfo } from "@/lib/connectivity/tunnel-resolver"

describe("useTunnelStatus", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("starts in a loading state with no URL", async () => {
    const loader = jest.fn().mockResolvedValue(null)
    const { result } = renderHook(() => useTunnelStatus(loader))
    expect(result.current).toEqual({ running: false, url: null, loading: true })
  })

  it("resolves to off when the loader returns null", async () => {
    const loader = jest.fn().mockResolvedValue(null)
    const { result } = renderHook(() => useTunnelStatus(loader))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toEqual({ running: false, url: null, loading: false })
  })

  it("surfaces the public URL when the tunnel is running", async () => {
    const info: TunnelInfo = {
      publicUrl: "https://example.trycloudflare.com",
      localUrl: "https://127.0.0.1:7890",
    }
    const loader = jest.fn().mockResolvedValue(info)
    const { result } = renderHook(() => useTunnelStatus(loader))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toEqual({
      running: true,
      url: "https://example.trycloudflare.com",
      loading: false,
    })
  })

  it("treats loader rejections as tunnel-off without throwing", async () => {
    const loader = jest.fn().mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useTunnelStatus(loader))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toEqual({ running: false, url: null, loading: false })
  })

  it("re-polls every 3 seconds", async () => {
    const loader = jest.fn().mockResolvedValueOnce(null).mockResolvedValue({
      publicUrl: "https://later.trycloudflare.com",
      localUrl: "https://127.0.0.1:7890",
    })
    const { result } = renderHook(() => useTunnelStatus(loader))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(loader).toHaveBeenCalledTimes(1)

    await act(async () => {
      jest.advanceTimersByTime(3_000)
    })
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.running).toBe(true))
    expect(result.current.url).toBe("https://later.trycloudflare.com")
  })

  it("clears the timer on unmount so it does not leak", async () => {
    const loader = jest.fn().mockResolvedValue(null)
    const { unmount } = renderHook(() => useTunnelStatus(loader))
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1))
    unmount()
    await act(async () => {
      jest.advanceTimersByTime(10_000)
    })
    expect(loader).toHaveBeenCalledTimes(1)
  })
})
