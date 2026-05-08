/** @jest-environment jsdom */

import { renderHook, act } from "@testing-library/react"

const onClaudeMessageMock = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  onClaudeMessage: (cb: (evt: unknown) => void) => onClaudeMessageMock(cb),
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

import {
  __injectReadyForTesting,
  __resetSidecarInfoForTesting,
  useSidecarInfo,
} from "./sidecar-info"

beforeEach(() => {
  __resetSidecarInfoForTesting()
  onClaudeMessageMock.mockReset()
  isTauriMock.mockReturnValue(true)
})

describe("useSidecarInfo", () => {
  it("returns the initial { ready: false } before any event lands", () => {
    onClaudeMessageMock.mockResolvedValue(() => {})
    const { result } = renderHook(() => useSidecarInfo())
    expect(result.current).toEqual({ ready: false })
  })

  it("captures sdkVersion + sidecarVersion from a ready event", () => {
    onClaudeMessageMock.mockResolvedValue(() => {})
    const { result } = renderHook(() => useSidecarInfo())
    act(() => {
      __injectReadyForTesting({
        type: "ready",
        sdkVersion: "0.42.0",
        sidecarVersion: "0.1.0",
      })
    })
    expect(result.current.ready).toBe(true)
    expect(result.current.sdkVersion).toBe("0.42.0")
    expect(result.current.sidecarVersion).toBe("0.1.0")
  })

  it("ignores non-ready events", () => {
    onClaudeMessageMock.mockResolvedValue(() => {})
    const { result } = renderHook(() => useSidecarInfo())
    act(() => {
      __injectReadyForTesting({ type: "log", level: "info", message: "hi" } as unknown as never)
    })
    expect(result.current).toEqual({ ready: false })
  })

  it("subscribes to onClaudeMessage on first read", async () => {
    onClaudeMessageMock.mockResolvedValue(() => {})
    renderHook(() => useSidecarInfo())
    // The subscription is async (await onClaudeMessage); flush microtasks.
    await Promise.resolve()
    await Promise.resolve()
    expect(onClaudeMessageMock).toHaveBeenCalled()
  })

  it("survives an onClaudeMessage rejection without throwing", async () => {
    onClaudeMessageMock.mockRejectedValue(new Error("no transport"))
    const { result } = renderHook(() => useSidecarInfo())
    await Promise.resolve()
    await Promise.resolve()
    expect(result.current).toEqual({ ready: false })
  })

  it("skips the listener install in web mode", async () => {
    isTauriMock.mockReturnValue(false)
    renderHook(() => useSidecarInfo())
    await Promise.resolve()
    await Promise.resolve()
    expect(onClaudeMessageMock).not.toHaveBeenCalled()
  })
})
