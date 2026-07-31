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

  it("verify() reports ok when the active probe confirms confinement", async () => {
    mockCall.mockImplementation(async (cmd: string) => {
      if (cmd === "sandbox_health_check") {
        return { backend: "macos-sandbox-exec", confined: true, detail: "ok" }
      }
      return { available: true, backend: "macos-sandbox-exec", version: "system", last_error: "" }
    })
    const { result } = renderHook(() => useSandboxHealth({ paused: true }))
    expect(result.current.probe.status).toBe("idle")
    await act(async () => {
      await result.current.verify()
    })
    expect(result.current.probe.status).toBe("ok")
    expect(result.current.probe.backend).toBe("macos-sandbox-exec")
    expect(result.current.probe.detail).toBe("ok")
  })

  it("verify() reports failed (with detail) when confinement is not enforced", async () => {
    mockCall.mockImplementation(async (cmd: string) => {
      if (cmd === "sandbox_health_check") {
        return { backend: "linux-bwrap", confined: false, detail: "write not blocked" }
      }
      return { available: true, backend: "linux-bwrap", version: "system", last_error: "" }
    })
    const { result } = renderHook(() => useSandboxHealth({ paused: true }))
    await act(async () => {
      await result.current.verify()
    })
    expect(result.current.probe.status).toBe("failed")
    expect(result.current.probe.detail).toBe("write not blocked")
  })

  it("verify() reports failed when the probe IPC rejects (web mode)", async () => {
    mockCall.mockRejectedValue(new Error("tauri-only command from web mode"))
    const { result } = renderHook(() => useSandboxHealth({ paused: true }))
    await act(async () => {
      await result.current.verify()
    })
    expect(result.current.probe.status).toBe("failed")
    expect(result.current.probe.detail).toContain("web mode")
  })

  it("verify() tolerates a null/partial probe payload", async () => {
    mockCall.mockResolvedValue(null as never)
    const { result } = renderHook(() => useSandboxHealth({ paused: true }))
    await act(async () => {
      await result.current.verify()
    })
    expect(result.current.probe.status).toBe("failed")
    expect(result.current.probe.backend).toBe("")
    expect(result.current.probe.detail).toBe("")
  })

  it("verify() stringifies non-Error rejections", async () => {
    mockCall.mockRejectedValue("string failure")
    const { result } = renderHook(() => useSandboxHealth({ paused: true }))
    await act(async () => {
      await result.current.verify()
    })
    expect(result.current.probe.detail).toBe("string failure")
  })

  it("normalises missing health fields to defaults", async () => {
    mockCall.mockResolvedValue({ available: false } as never)
    const { result } = renderHook(() => useSandboxHealth({ pollIntervalMs: 100_000 }))
    await waitFor(() => expect(mockCall).toHaveBeenCalled())
    expect(result.current.health.backend).toBe("unknown")
    expect(result.current.health.version).toBe("")
    expect(result.current.health.lastError).toBe("")
  })

  it("accepts the camelCase lastError shape", async () => {
    mockCall.mockResolvedValue({
      available: true,
      backend: "mock",
      version: "",
      lastError: "camel",
    } as never)
    const { result } = renderHook(() => useSandboxHealth({ pollIntervalMs: 100_000 }))
    await waitFor(() => expect(result.current.health.lastError).toBe("camel"))
  })

  it("falls back to DEFAULT_HEALTH on a null payload", async () => {
    mockCall.mockResolvedValue(null as never)
    const { result } = renderHook(() => useSandboxHealth({ pollIntervalMs: 100_000 }))
    await waitFor(() => expect(mockCall).toHaveBeenCalled())
    expect(result.current.health.backend).toBe("unknown")
    expect(result.current.health.available).toBe(false)
  })

  it("stringifies non-Error refresh rejections", async () => {
    mockCall.mockRejectedValue("boom")
    const { result } = renderHook(() => useSandboxHealth({ pollIntervalMs: 100_000 }))
    await waitFor(() => expect(result.current.error).toBe("boom"))
  })

  it("verify() ignores its result after the hook unmounts", async () => {
    let resolveProbe: (v: unknown) => void = () => undefined
    mockCall.mockImplementation((cmd: string) => {
      if (cmd === "sandbox_health_check") {
        return new Promise((r) => {
          resolveProbe = r
        })
      }
      return Promise.resolve({ available: true, backend: "mock", version: "", last_error: "" })
    })
    const { result, unmount } = renderHook(() => useSandboxHealth({ pollIntervalMs: 100_000 }))
    await act(async () => {
      jest.advanceTimersByTime(0)
      await Promise.resolve()
    })
    let p!: Promise<void>
    act(() => {
      p = result.current.verify()
    })
    expect(result.current.probe.status).toBe("running")
    unmount() // not paused → cleanup flips aliveRef
    await act(async () => {
      resolveProbe({ backend: "x", confined: true, detail: "ok" })
      await p
    })
    // The post-unmount guard skipped setProbe, so it never reached "ok".
    expect(result.current.probe.status).toBe("running")
  })

  it("refresh() ignores its result after the hook unmounts", async () => {
    let resolveHealth: (v: unknown) => void = () => undefined
    mockCall.mockImplementation(
      () =>
        new Promise((r) => {
          resolveHealth = r
        })
    )
    const { result, unmount } = renderHook(() => useSandboxHealth({ pollIntervalMs: 100_000 }))
    await act(async () => {
      jest.advanceTimersByTime(0)
    })
    unmount() // aliveRef → false
    await act(async () => {
      resolveHealth({ available: true, backend: "x", version: "", last_error: "" })
      await Promise.resolve()
    })
    // setHealth skipped after unmount → still the default.
    expect(result.current.health.backend).toBe("unknown")
  })

  it("re-probes health on each poll interval tick", async () => {
    mockCall.mockResolvedValue({
      available: true,
      backend: "mock",
      version: "",
      last_error: "",
    })
    renderHook(() => useSandboxHealth({ pollIntervalMs: 1_000 }))
    await act(async () => {
      await Promise.resolve()
    })
    const afterInitial = mockCall.mock.calls.length
    await act(async () => {
      jest.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(mockCall.mock.calls.length).toBeGreaterThan(afterInitial)
  })
})
