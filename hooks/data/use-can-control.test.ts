/**
 * @jest-environment jsdom
 */

import { renderHook, waitFor } from "@testing-library/react"

import { useCanControl } from "./use-can-control"

const callMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: { call: (name: string, args?: unknown) => callMock(name, args) },
}))

let platform: "tauri" | "mobile" | "web" = "mobile"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platform,
}))

beforeEach(() => {
  platform = "mobile"
  callMock.mockReset()
})

describe("useCanControl", () => {
  it("probes companion_can_control on mobile and reflects allowed=true", async () => {
    callMock.mockResolvedValue({ allowed: true })
    const { result } = renderHook(() => useCanControl())
    await waitFor(() => expect(result.current).toBe(true))
    expect(callMock).toHaveBeenCalledWith("companion_can_control", undefined)
  })

  it("reflects allowed=false for an observe-only device", async () => {
    callMock.mockResolvedValue({ allowed: false })
    const { result } = renderHook(() => useCanControl())
    await waitFor(() => expect(result.current).toBe(false))
  })

  it("stays 'unknown' when the probe rejects (not paired / offline)", async () => {
    callMock.mockRejectedValue(new Error("not_paired"))
    const { result } = renderHook(() => useCanControl())
    await waitFor(() => expect(callMock).toHaveBeenCalled())
    expect(result.current).toBe("unknown")
  })

  it("short-circuits to true off mobile without probing", async () => {
    platform = "tauri"
    const { result } = renderHook(() => useCanControl())
    await waitFor(() => expect(result.current).toBe(true))
    expect(callMock).not.toHaveBeenCalled()
  })
})
