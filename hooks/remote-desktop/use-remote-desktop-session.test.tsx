import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { RemoteDesktopError } from "@/lib/remote-desktop/host-client"

import { useRemoteDesktopSession } from "./use-remote-desktop-session"

const target = { targetId: "t", bindingId: "b" }

function opened(sessionId: string, mode: "view" | "control" = "control") {
  return {
    sessionId,
    url: `ws://127.0.0.1:1/rd/${sessionId}`,
    mode,
    expiresAt: 1,
    ...(mode === "control" ? { lease: { token: "x", fence: 1, expiresAt: 1 } } : {}),
  }
}

describe("useRemoteDesktopSession", () => {
  it("opens, renews and closes on unmount", async () => {
    jest.useFakeTimers()
    const open = jest.fn().mockResolvedValue(opened("s1"))
    const renew = jest
      .fn()
      .mockResolvedValue({ expiresAt: 99, lease: { token: "x", fence: 1, expiresAt: 99 } })
    const close = jest.fn().mockResolvedValue(undefined)
    const { result, unmount } = renderHook(() =>
      useRemoteDesktopSession(target, { open, renew, close, renewMs: 5000 })
    )
    await act(() => result.current.connect("control"))
    expect(open).toHaveBeenCalledWith({
      targetId: "t",
      bindingId: "b",
      mode: "control",
      takeover: false,
    })
    expect(result.current.state.status).toBe("open")
    await act(async () => {
      jest.advanceTimersByTime(5000)
    })
    expect(renew).toHaveBeenCalledWith("s1")
    await waitFor(() =>
      expect(result.current.state.status === "open" && result.current.state.session.expiresAt).toBe(
        99
      )
    )
    unmount()
    expect(close).toHaveBeenCalledWith("s1")
    jest.useRealTimers()
  })

  it("asks before taking control from someone else, then takes over", async () => {
    const open = jest
      .fn()
      .mockRejectedValueOnce(new Error("remote_desktop_control_busy"))
      .mockResolvedValueOnce(opened("s2"))
    const { result } = renderHook(() =>
      useRemoteDesktopSession(target, {
        open,
        renew: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
      })
    )
    await act(() => result.current.connect("control"))
    expect(result.current.state.status).toBe("busy")
    await act(() => result.current.connect("control", true))
    expect(open).toHaveBeenLastCalledWith({
      targetId: "t",
      bindingId: "b",
      mode: "control",
      takeover: true,
    })
    expect(result.current.state.status).toBe("open")
  })

  it("closes the previous session before switching mode", async () => {
    const open = jest
      .fn()
      .mockResolvedValueOnce(opened("s1"))
      .mockResolvedValueOnce(opened("s2", "view"))
    const close = jest.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useRemoteDesktopSession(target, { open, renew: jest.fn(), close })
    )
    await act(() => result.current.connect("control"))
    await act(() => result.current.connect("view"))
    expect(close).toHaveBeenCalledWith("s1")
    expect(result.current.state.status === "open" && result.current.state.session.mode).toBe("view")
  })

  it("ends when renewal says control was taken", async () => {
    const renew = jest.fn().mockRejectedValue(new Error("remote_desktop_lease_lost"))
    const { result } = renderHook(() =>
      useRemoteDesktopSession(target, {
        open: jest.fn().mockResolvedValue(opened("s1")),
        renew,
        close: jest.fn().mockResolvedValue(undefined),
        renewMs: 10,
      })
    )
    await act(() => result.current.connect("control"))
    await waitFor(() => expect(result.current.state.status).toBe("ended"))
    const state = result.current.state
    expect(state.status === "ended" && state.error?.code).toBe("remote_desktop_lease_lost")
  })

  it("reports open failures and explicit ends", async () => {
    const close = jest.fn().mockResolvedValue(undefined)
    const open = jest
      .fn()
      .mockRejectedValueOnce(new Error("remote_desktop_connect_failed"))
      .mockResolvedValueOnce(opened("s3"))
    const { result } = renderHook(() =>
      useRemoteDesktopSession(target, { open, renew: jest.fn(), close })
    )
    await act(() => result.current.connect("control"))
    expect(result.current.state).toMatchObject({
      status: "ended",
      error: { code: "remote_desktop_connect_failed" },
    })
    await act(() => result.current.connect("control"))
    act(() => result.current.markEnded(new RemoteDesktopError("remote_desktop_connection_lost")))
    expect(close).toHaveBeenCalledWith("s3")
    expect(result.current.state).toMatchObject({
      status: "ended",
      error: { code: "remote_desktop_connection_lost" },
    })
    act(() => result.current.disconnect())
    expect(result.current.state).toEqual({ status: "ended" })
  })

  it("does nothing without a target", async () => {
    const open = jest.fn()
    const { result } = renderHook(() => useRemoteDesktopSession(null, { open }))
    await act(() => result.current.connect("control"))
    expect(open).not.toHaveBeenCalled()
  })
})
