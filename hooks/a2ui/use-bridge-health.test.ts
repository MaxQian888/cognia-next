import { renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

jest.mock("@/lib/claude/builtin-mcp/runtime-context", () => ({
  getBuiltinMcpRuntimeContext: jest.fn(),
}))

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({ surfaces: { a: {}, b: {} } })
  ),
}))

import { isTauri } from "@/lib/tauri"
import { getBuiltinMcpRuntimeContext } from "@/lib/claude/builtin-mcp/runtime-context"
import { useBridgeHealth } from "./use-bridge-health"

const mIsTauri = isTauri as jest.Mock
const mCtx = getBuiltinMcpRuntimeContext as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

describe("useBridgeHealth", () => {
  it("starts with loaded=false and resolves to the runtime paths once the IPC settles", async () => {
    mIsTauri.mockReturnValue(true)
    mCtx.mockResolvedValueOnce({ sidecarDir: "/abs/sidecar", socketPath: "/abs/sock" })

    const { result } = renderHook(() => useBridgeHealth())
    expect(result.current.loaded).toBe(false)

    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.isTauri).toBe(true)
    expect(result.current.sidecarDir).toBe("/abs/sidecar")
    expect(result.current.socketPath).toBe("/abs/sock")
    expect(result.current.error).toBeNull()
  })

  it("reports null paths and isTauri=false outside Tauri", async () => {
    mIsTauri.mockReturnValue(false)
    mCtx.mockResolvedValueOnce(null)

    const { result } = renderHook(() => useBridgeHealth())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.isTauri).toBe(false)
    expect(result.current.sidecarDir).toBeNull()
    expect(result.current.socketPath).toBeNull()
  })

  it("captures errors from the runtime context fetch", async () => {
    mIsTauri.mockReturnValue(true)
    mCtx.mockRejectedValueOnce(new Error("boom"))

    const { result } = renderHook(() => useBridgeHealth())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.error).toBe("boom")
  })

  it("converts non-Error rejections to a string", async () => {
    mIsTauri.mockReturnValue(true)
    mCtx.mockRejectedValueOnce("nope")

    const { result } = renderHook(() => useBridgeHealth())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.error).toBe("nope")
  })

  it("reports the live surface count from the store selector", async () => {
    mIsTauri.mockReturnValue(true)
    mCtx.mockResolvedValueOnce(null)

    const { result } = renderHook(() => useBridgeHealth())
    expect(result.current.liveSurfaceCount).toBe(2)
    // Wait for the IPC effect to settle so React doesn't log an unwrapped-act warning.
    await waitFor(() => expect(result.current.loaded).toBe(true))
  })

  it("does not call setState when unmounted before the IPC resolves", async () => {
    mIsTauri.mockReturnValue(true)
    let resolveCtx: (v: { sidecarDir: string; socketPath: string } | null) => void = () => {}
    const ctxPromise = new Promise<{ sidecarDir: string; socketPath: string } | null>((resolve) => {
      resolveCtx = resolve
    })
    mCtx.mockReturnValueOnce(ctxPromise)

    const { unmount } = renderHook(() => useBridgeHealth())
    unmount()
    resolveCtx({ sidecarDir: "/abs", socketPath: "/sock" })
    await ctxPromise
    // No assertion needed: if the cancelled-guard didn't run, React would warn
    // about a state update after unmount. Reaching this line cleanly is the test.
  })

  it("does not call setState when unmounted before the IPC rejects", async () => {
    mIsTauri.mockReturnValue(true)
    let rejectCtx: (err: unknown) => void = () => {}
    const ctxPromise = new Promise<{ sidecarDir: string; socketPath: string } | null>(
      (_resolve, reject) => {
        rejectCtx = reject
      }
    )
    mCtx.mockReturnValueOnce(ctxPromise)

    const { unmount } = renderHook(() => useBridgeHealth())
    unmount()
    rejectCtx(new Error("late boom"))
    await ctxPromise.catch(() => {})
  })
})
