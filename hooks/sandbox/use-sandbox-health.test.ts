// ADR-0028 Phase 7 — useSandboxHealth hook tests.

import { act, renderHook, waitFor } from "@testing-library/react"

import { useSandboxHealth } from "./use-sandbox-health"

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

describe("useSandboxHealth", () => {
  it("probes once on mount and exposes the health payload", async () => {
    mockCall.mockResolvedValue({
      available: true,
      backend: "linux-bwrap",
      version: "system",
      last_error: "",
    })
    const { result } = renderHook(() => useSandboxHealth({ pollIntervalMs: 100_000 }))
    await waitFor(() => expect(result.current.health.available).toBe(true))
    expect(result.current.health.backend).toBe("linux-bwrap")
    expect(result.current.health.version).toBe("system")
  })

  it("normalises last_error to lastError", async () => {
    mockCall.mockResolvedValue({
      available: false,
      backend: "windows-codex-vendor-pending",
      version: "",
      last_error: "vendoring pending",
    })
    const { result } = renderHook(() => useSandboxHealth({ pollIntervalMs: 100_000 }))
    await waitFor(() => expect(result.current.health.lastError).toBe("vendoring pending"))
  })

  it("surfaces transport rejections via error", async () => {
    mockCall.mockRejectedValue(new Error("ipc down"))
    const { result } = renderHook(() => useSandboxHealth({ pollIntervalMs: 100_000 }))
    await waitFor(() => expect(result.current.error).toBe("ipc down"))
  })

  it("re-probes when refresh() is called", async () => {
    mockCall.mockResolvedValue({
      available: false,
      backend: "uninstalled-unknown",
      version: "",
      last_error: "first",
    })
    const { result } = renderHook(() => useSandboxHealth({ pollIntervalMs: 100_000 }))
    await waitFor(() => expect(mockCall).toHaveBeenCalledTimes(1))

    mockCall.mockResolvedValueOnce({
      available: true,
      backend: "macos-sandbox-exec",
      version: "system",
      last_error: "",
    })
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.health.backend).toBe("macos-sandbox-exec")
  })

  it("does not poll when paused", async () => {
    mockCall.mockResolvedValue({
      available: true,
      backend: "mock",
      version: "test-only",
      last_error: "",
    })
    renderHook(() => useSandboxHealth({ pollIntervalMs: 1_000, paused: true }))
    // Advance time — but no probe should happen because paused=true.
    act(() => {
      jest.advanceTimersByTime(5_000)
    })
    expect(mockCall).not.toHaveBeenCalled()
  })
})
