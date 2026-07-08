/** @jest-environment jsdom */
/**
 * Plugin Dev Server Client Hook Tests
 */

import { renderHook, act } from "@testing-library/react"

const mockStart = jest.fn().mockResolvedValue(undefined)
const mockStop = jest.fn().mockResolvedValue(undefined)
const mockBuildPlugin = jest
  .fn()
  .mockResolvedValue({ success: true, pluginId: "test", duration: 100 })
const mockClearConsoleLogs = jest.fn()
const mockGetConsoleLogs = jest.fn().mockReturnValue([])
const mockGetStatus = jest.fn().mockReturnValue({
  running: false,
  port: 9527,
  host: "localhost",
  url: "http://localhost:9527",
  connectedClients: 0,
})
const mockOnConsoleLog = jest.fn().mockReturnValue(() => {})
const mockOnMessage = jest.fn().mockReturnValue(() => {})

jest.mock("./dev-server", () => ({
  getPluginDevServer: () => ({
    start: mockStart,
    stop: mockStop,
    buildPlugin: mockBuildPlugin,
    clearConsoleLogs: mockClearConsoleLogs,
    getConsoleLogs: mockGetConsoleLogs,
    getStatus: mockGetStatus,
    onConsoleLog: mockOnConsoleLog,
    onMessage: mockOnMessage,
  }),
}))

import { usePluginDevServer } from "./dev-server.client"

describe("usePluginDevServer", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetStatus.mockReturnValue({
      running: false,
      port: 9527,
      host: "localhost",
      url: "http://localhost:9527",
      connectedClients: 0,
    })
    mockGetConsoleLogs.mockReturnValue([])
    mockOnConsoleLog.mockReturnValue(() => {})
    mockOnMessage.mockReturnValue(() => {})
  })

  it("returns initial status from devServer.getStatus()", () => {
    const { result } = renderHook(() => usePluginDevServer())
    expect(result.current.status).toEqual({
      running: false,
      port: 9527,
      host: "localhost",
      url: "http://localhost:9527",
      connectedClients: 0,
    })
  })

  it("returns empty consoleLogs initially", () => {
    const { result } = renderHook(() => usePluginDevServer())
    expect(result.current.consoleLogs).toEqual([])
  })

  it("subscribes to console logs and messages on mount", () => {
    renderHook(() => usePluginDevServer())
    expect(mockOnConsoleLog).toHaveBeenCalledTimes(1)
    expect(mockOnMessage).toHaveBeenCalledTimes(1)
  })

  it("unsubscribes on unmount", () => {
    const unsubConsole = jest.fn()
    const unsubMessage = jest.fn()
    mockOnConsoleLog.mockReturnValue(unsubConsole)
    mockOnMessage.mockReturnValue(unsubMessage)

    const { unmount } = renderHook(() => usePluginDevServer())
    unmount()

    expect(unsubConsole).toHaveBeenCalled()
    expect(unsubMessage).toHaveBeenCalled()
  })

  it("start calls devServer.start and updates status", async () => {
    mockGetStatus
      .mockReturnValueOnce({
        running: false,
        port: 9527,
        host: "localhost",
        url: "http://localhost:9527",
        connectedClients: 0,
      })
      .mockReturnValue({
        running: true,
        port: 9527,
        host: "localhost",
        url: "http://localhost:9527",
        connectedClients: 1,
      })

    const { result } = renderHook(() => usePluginDevServer())

    await act(async () => {
      await result.current.start()
    })

    expect(mockStart).toHaveBeenCalled()
  })

  it("stop calls devServer.stop and updates status", async () => {
    const { result } = renderHook(() => usePluginDevServer())

    await act(async () => {
      await result.current.stop()
    })

    expect(mockStop).toHaveBeenCalled()
  })

  it("build calls devServer.buildPlugin with pluginId", async () => {
    const { result } = renderHook(() => usePluginDevServer())

    await act(async () => {
      const buildResult = await result.current.build("my-plugin")
      expect(buildResult).toEqual({ success: true, pluginId: "test", duration: 100 })
    })

    expect(mockBuildPlugin).toHaveBeenCalledWith("my-plugin")
  })

  it("clearLogs calls devServer.clearConsoleLogs and refreshes logs", () => {
    const { result } = renderHook(() => usePluginDevServer())

    act(() => {
      result.current.clearLogs("my-plugin")
    })

    expect(mockClearConsoleLogs).toHaveBeenCalledWith("my-plugin")
    expect(mockGetConsoleLogs).toHaveBeenCalled()
  })

  it("clearLogs without pluginId clears all", () => {
    const { result } = renderHook(() => usePluginDevServer())

    act(() => {
      result.current.clearLogs()
    })

    expect(mockClearConsoleLogs).toHaveBeenCalledWith(undefined)
  })

  it("exposes the devServer instance", () => {
    const { result } = renderHook(() => usePluginDevServer())
    expect(result.current.devServer).toBeDefined()
    expect(result.current.devServer.start).toBe(mockStart)
  })

  it("appends console logs when onConsoleLog fires", () => {
    let consoleCallback: (log: unknown) => void = () => {}
    mockOnConsoleLog.mockImplementation((cb: (log: unknown) => void) => {
      consoleCallback = cb
      return () => {}
    })

    const { result } = renderHook(() => usePluginDevServer())

    act(() => {
      consoleCallback({
        level: "info",
        pluginId: "test",
        message: "hello",
        timestamp: Date.now(),
      })
    })

    expect(result.current.consoleLogs).toHaveLength(1)
    expect(result.current.consoleLogs[0]).toHaveProperty("message", "hello")
  })
})
