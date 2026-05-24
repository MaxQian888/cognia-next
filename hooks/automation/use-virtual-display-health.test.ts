// Screen-off Computer Use — useVirtualDisplayHealth hook tests.

import { act, renderHook, waitFor } from "@testing-library/react"

import { useVirtualDisplayHealth } from "./use-virtual-display-health"

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
}))

import { transport } from "@/lib/tauri"

const mockCall = transport.call as jest.MockedFunction<typeof transport.call>

beforeEach(() => {
  mockCall.mockReset()
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe("useVirtualDisplayHealth", () => {
  it("probes once on mount and exposes the health payload", async () => {
    mockCall.mockResolvedValue({
      available: true,
      installed: true,
      backend: "windows-parsec-vdd",
      driverVersion: "0.1.0",
      activeMonitor: "\\\\.\\DISPLAY3",
      lastError: "",
    })
    const { result } = renderHook(() => useVirtualDisplayHealth({ pollIntervalMs: 100_000 }))
    await waitFor(() => expect(result.current.health.available).toBe(true))
    expect(result.current.health.installed).toBe(true)
    expect(result.current.health.backend).toBe("windows-parsec-vdd")
    expect(result.current.health.activeMonitor).toBe("\\\\.\\DISPLAY3")
  })

  it("tolerates snake_case from a serde config change", async () => {
    mockCall.mockResolvedValue({
      available: false,
      installed: false,
      backend: "windows-parsec-vdd",
      driver_version: "0.1.0",
      active_monitor: "",
      last_error: "driver not installed",
    })
    const { result } = renderHook(() => useVirtualDisplayHealth({ pollIntervalMs: 100_000 }))
    await waitFor(() => expect(result.current.health.lastError).toBe("driver not installed"))
    expect(result.current.health.driverVersion).toBe("0.1.0")
  })

  it("surfaces transport rejections via error", async () => {
    mockCall.mockRejectedValue(new Error("ipc down"))
    const { result } = renderHook(() => useVirtualDisplayHealth({ pollIntervalMs: 100_000 }))
    await waitFor(() => expect(result.current.error).toBe("ipc down"))
  })

  it("re-probes when refresh() is called", async () => {
    mockCall.mockResolvedValue({
      available: false,
      installed: false,
      backend: "windows-parsec-vdd",
      lastError: "not installed",
    })
    const { result } = renderHook(() => useVirtualDisplayHealth({ pollIntervalMs: 100_000 }))
    await waitFor(() => expect(mockCall).toHaveBeenCalledTimes(1))

    mockCall.mockResolvedValueOnce({
      available: true,
      installed: true,
      backend: "windows-parsec-vdd",
      driverVersion: "0.1.0",
      lastError: "",
    })
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.health.available).toBe(true)
  })

  it("does not poll when paused", async () => {
    mockCall.mockResolvedValue({
      available: false,
      installed: false,
      backend: "windows-parsec-vdd",
      lastError: "",
    })
    renderHook(() => useVirtualDisplayHealth({ pollIntervalMs: 1_000, paused: true }))
    act(() => {
      jest.advanceTimersByTime(5_000)
    })
    expect(mockCall).not.toHaveBeenCalled()
  })
})
