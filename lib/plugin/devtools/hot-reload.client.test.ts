/**
 * Plugin Hot Reload Client Hook Tests
 */

import { renderHook, act } from "@testing-library/react"

const mockReloadPlugin = jest
  .fn()
  .mockResolvedValue({ success: true, pluginId: "test", duration: 50 })
const mockReloadAll = jest
  .fn()
  .mockResolvedValue([{ success: true, pluginId: "test", duration: 50 }])
const mockIsWatching = jest.fn().mockReturnValue(false)
const mockGetReloadHistory = jest.fn().mockReturnValue([])
const mockOnReload = jest.fn().mockReturnValue(() => {})

jest.mock("./hot-reload", () => ({
  getPluginHotReload: () => ({
    reloadPlugin: mockReloadPlugin,
    reloadAll: mockReloadAll,
    isWatching: mockIsWatching,
    getReloadHistory: mockGetReloadHistory,
    onReload: mockOnReload,
  }),
}))

import { usePluginHotReload } from "./hot-reload.client"

describe("usePluginHotReload", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsWatching.mockReturnValue(false)
    mockGetReloadHistory.mockReturnValue([])
    mockOnReload.mockReturnValue(() => {})
  })

  it("returns initial isWatching state", () => {
    const { result } = renderHook(() => usePluginHotReload())
    expect(result.current.isWatching).toBe(false)
  })

  it("returns initial empty reloadHistory", () => {
    const { result } = renderHook(() => usePluginHotReload())
    expect(result.current.reloadHistory).toEqual([])
  })

  it("subscribes to reload events on mount", () => {
    renderHook(() => usePluginHotReload())
    expect(mockOnReload).toHaveBeenCalledTimes(1)
  })

  it("unsubscribes on unmount", () => {
    const unsub = jest.fn()
    mockOnReload.mockReturnValue(unsub)

    const { unmount } = renderHook(() => usePluginHotReload())
    unmount()

    expect(unsub).toHaveBeenCalled()
  })

  it("reloadPlugin calls hotReload.reloadPlugin with pluginId", async () => {
    const { result } = renderHook(() => usePluginHotReload())

    await act(async () => {
      const res = await result.current.reloadPlugin("my-plugin")
      expect(res).toEqual({ success: true, pluginId: "test", duration: 50 })
    })

    expect(mockReloadPlugin).toHaveBeenCalledWith("my-plugin")
  })

  it("reloadAll calls hotReload.reloadAll", async () => {
    const { result } = renderHook(() => usePluginHotReload())

    await act(async () => {
      const res = await result.current.reloadAll()
      expect(res).toEqual([{ success: true, pluginId: "test", duration: 50 }])
    })

    expect(mockReloadAll).toHaveBeenCalled()
  })

  it("exposes the hotReload instance", () => {
    const { result } = renderHook(() => usePluginHotReload())
    expect(result.current.hotReload).toBeDefined()
    expect(result.current.hotReload.reloadPlugin).toBe(mockReloadPlugin)
  })

  it("appends to reloadHistory when onReload fires", () => {
    let reloadCallback: (result: unknown) => void = () => {}
    mockOnReload.mockImplementation((cb: (result: unknown) => void) => {
      reloadCallback = cb
      return () => {}
    })

    const { result } = renderHook(() => usePluginHotReload())

    act(() => {
      reloadCallback({ success: true, pluginId: "test-plugin", duration: 42 })
    })

    expect(result.current.reloadHistory).toHaveLength(1)
    expect(result.current.reloadHistory[0]).toHaveProperty("pluginId", "test-plugin")
  })

  it("updates isWatching when onReload fires", () => {
    let reloadCallback: (result: unknown) => void = () => {}
    mockOnReload.mockImplementation((cb: (result: unknown) => void) => {
      reloadCallback = cb
      return () => {}
    })
    mockIsWatching.mockReturnValue(false)

    const { result } = renderHook(() => usePluginHotReload())
    expect(result.current.isWatching).toBe(false)

    mockIsWatching.mockReturnValue(true)

    act(() => {
      reloadCallback({ success: true, pluginId: "p", duration: 10 })
    })

    expect(result.current.isWatching).toBe(true)
  })

  it("limits reloadHistory to 50 entries", () => {
    let reloadCallback: (result: unknown) => void = () => {}
    mockOnReload.mockImplementation((cb: (result: unknown) => void) => {
      reloadCallback = cb
      return () => {}
    })

    const { result } = renderHook(() => usePluginHotReload())

    act(() => {
      for (let i = 0; i < 55; i++) {
        reloadCallback({ success: true, pluginId: `p-${i}`, duration: i })
      }
    })

    expect(result.current.reloadHistory.length).toBeLessThanOrEqual(50)
  })
})
