/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

const mockToast = { error: jest.fn(), warning: jest.fn(), success: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToast.error(...args),
    warning: (...args: unknown[]) => mockToast.warning(...args),
    success: (...args: unknown[]) => mockToast.success(...args),
  },
}))

let mockAuthority: "local" | "host" = "local"
const listeners = new Set<() => void>()
const mockRun = jest.fn()
jest.mock("@/lib/memory/control-plane/routed-manage", () => ({
  memoryWriteAuthority: () => mockAuthority,
  subscribeMemoryWriteAuthority: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  runMemoryCommand: (...args: unknown[]) => mockRun(...args),
}))

import { useMemoryCommand } from "./use-memory-command"

beforeEach(() => {
  jest.clearAllMocks()
  mockAuthority = "local"
  mockRun.mockResolvedValue({ ok: true, memoryId: "m1" })
})

describe("useMemoryCommand", () => {
  it("runs through the routed door with the current authority and a queue label", async () => {
    const { result } = renderHook(() => useMemoryCommand())
    let landed = false
    await act(async () => {
      landed = await result.current.run({ kind: "pin", id: "m1", pinned: true })
    })
    expect(landed).toBe(true)
    expect(mockRun).toHaveBeenCalledWith(
      { kind: "pin", id: "m1", pinned: true },
      { authority: "local", label: "Pin memory" }
    )
  })

  it("follows the authority when routing changes", () => {
    const { result } = renderHook(() => useMemoryCommand())
    expect(result.current.authority).toBe("local")
    mockAuthority = "host"
    act(() => {
      for (const listener of listeners) listener()
    })
    expect(result.current.authority).toBe("host")
  })

  it("toasts a refusal and reports it did not land", async () => {
    mockRun.mockResolvedValueOnce({ ok: false, reason: "pii_blocked" })
    const { result } = renderHook(() => useMemoryCommand())
    let landed = true
    await act(async () => {
      landed = await result.current.run({ kind: "delete", id: "m1" })
    })
    expect(landed).toBe(false)
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/./))
  })

  it("warns when the stored text was redacted, locally or on the way to the host", async () => {
    const { result } = renderHook(() => useMemoryCommand())
    mockRun.mockResolvedValueOnce({ ok: true, piiRedacted: true })
    await act(async () => {
      await result.current.run({ kind: "update", id: "m1", patch: { text: "x" } })
    })
    mockRun.mockResolvedValueOnce({ ok: true, queued: true, piiRedacted: true })
    await act(async () => {
      await result.current.run({ kind: "update", id: "m1", patch: { text: "y" } })
    })
    expect(mockToast.warning).toHaveBeenCalledTimes(2)
  })

  it("turns a thrown command into a generic failure", async () => {
    mockRun.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() => useMemoryCommand())
    let landed = true
    await act(async () => {
      landed = await result.current.run({ kind: "restore", id: "m1" })
    })
    expect(landed).toBe(false)
    expect(mockToast.error).toHaveBeenCalled()
  })
})
