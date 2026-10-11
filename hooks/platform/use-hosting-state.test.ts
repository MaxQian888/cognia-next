/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

const hasCapabilityMock = jest.fn(() => true)
jest.mock("@/lib/platform/capabilities", () => ({
  hasCapability: (...args: unknown[]) => hasCapabilityMock(...(args as [])),
}))

const remoteActiveMock = jest.fn(() => false)
jest.mock("@/hooks/use-host-profile", () => ({
  useRemoteHostActive: () => remoteActiveMock(),
}))

const invokeMock = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/tauri/autostart", () => ({ setAutostart: jest.fn().mockResolvedValue(undefined) }))
jest.mock("@/lib/tauri/close-behavior", () => ({
  setCloseBehavior: jest.fn().mockResolvedValue(undefined),
}))

import { __resetHostModeForTests } from "@/lib/tauri/host-mode"

import { useHostingState } from "./use-hosting-state"

beforeEach(() => {
  jest.clearAllMocks()
  hasCapabilityMock.mockReturnValue(true)
  remoteActiveMock.mockReturnValue(false)
  __resetHostModeForTests()
})

describe("useHostingState", () => {
  it("reads host mode on mount and reports hosting", async () => {
    invokeMock.mockResolvedValue({ enabled: true, bootHidden: false })
    const { result } = renderHook(() => useHostingState())
    expect(result.current.loaded).toBe(false)
    expect(result.current.state).toBe("off")
    await waitFor(() => expect(result.current.state).toBe("hosting"))
    expect(result.current.loaded).toBe(true)
    expect(hasCapabilityMock).toHaveBeenCalledWith("always-on")
    expect(invokeMock).toHaveBeenCalledWith("host_mode_get")
  })

  it("stands by while the desktop drives a remote host", async () => {
    remoteActiveMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({ enabled: true, bootHidden: false })
    const { result } = renderHook(() => useHostingState())
    await waitFor(() => expect(result.current.state).toBe("standing-by"))
  })

  it("follows a change made through setEnabled", async () => {
    invokeMock.mockResolvedValueOnce({ enabled: false, bootHidden: false })
    const { result } = renderHook(() => useHostingState())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.state).toBe("off")
    invokeMock.mockResolvedValueOnce({ enabled: true, bootHidden: false })
    await act(async () => {
      await result.current.setEnabled(true)
    })
    expect(invokeMock).toHaveBeenCalledWith("host_mode_set", { enabled: true })
    expect(result.current.state).toBe("hosting")
  })

  it("never asks Rust on a shell without the capability", () => {
    hasCapabilityMock.mockReturnValue(false)
    const { result } = renderHook(() => useHostingState())
    expect(result.current.state).toBe("unsupported")
    expect(result.current.loaded).toBe(true)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
