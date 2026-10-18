import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/tauri/transport-instance", () => ({ localTransport: { call: jest.fn() } }))
jest.mock("@/lib/remote-host/management-channel", () => ({
  withManagementChannel: jest.fn(),
  acquireManagementChannel: jest.fn(),
}))

import { RemoteDesktopError } from "@/lib/remote-desktop/host-client"
import type { RemoteDesktopHostRef, RemoteDesktopSessionOpened } from "@/lib/remote-desktop/types"

import { useRemoteDesktopSession } from "./use-remote-desktop-session"

const target = { targetId: "t", bindingId: "b" }
const local: RemoteDesktopHostRef = { kind: "local" }
const phoneHost: RemoteDesktopHostRef = { kind: "remote", hostRef: "companion:h" }

function opened(
  sessionId: string,
  mode: "view" | "control" = "control"
): RemoteDesktopSessionOpened {
  return {
    sessionId,
    transport: "loopback",
    url: `ws://127.0.0.1:1/rd/${sessionId}`,
    mode,
    expiresAt: 1,
    ...(mode === "control" ? { lease: { token: "x", fence: 1, expiresAt: 1 } } : {}),
  }
}

/** A stream stand-in that records its close. */
function streams() {
  const closed: string[] = []
  const openStream = jest.fn(
    async (_host: RemoteDesktopHostRef, session: RemoteDesktopSessionOpened) => ({
      connection: session.url ?? `channel:${session.sessionId}`,
      close: () => closed.push(session.sessionId),
    })
  )
  return { openStream, closed }
}

describe("useRemoteDesktopSession", () => {
  it("opens the session and its stream, renews, and closes both on unmount", async () => {
    jest.useFakeTimers()
    const open = jest.fn().mockResolvedValue(opened("s1"))
    const renew = jest
      .fn()
      .mockResolvedValue({ expiresAt: 99, lease: { token: "x", fence: 1, expiresAt: 99 } })
    const close = jest.fn().mockResolvedValue(undefined)
    const { openStream, closed } = streams()
    const { result, unmount } = renderHook(() =>
      useRemoteDesktopSession(local, target, { open, renew, close, openStream, renewMs: 5000 })
    )
    await act(() => result.current.connect("control"))
    expect(open).toHaveBeenCalledWith(local, {
      targetId: "t",
      bindingId: "b",
      mode: "control",
      takeover: false,
    })
    expect(openStream).toHaveBeenCalledWith(local, expect.objectContaining({ sessionId: "s1" }))
    expect(result.current.state).toMatchObject({
      status: "open",
      connection: "ws://127.0.0.1:1/rd/s1",
    })
    await act(async () => {
      jest.advanceTimersByTime(5000)
    })
    expect(renew).toHaveBeenCalledWith(local, "s1")
    await waitFor(() =>
      expect(result.current.state.status === "open" && result.current.state.session.expiresAt).toBe(
        99
      )
    )
    unmount()
    expect(close).toHaveBeenCalledWith(local, "s1")
    expect(closed).toEqual(["s1"])
    jest.useRealTimers()
  })

  it("closes the session when its stream cannot be opened", async () => {
    const close = jest.fn().mockResolvedValue(undefined)
    const openStream = jest
      .fn()
      .mockRejectedValue(new RemoteDesktopError("remote_desktop_transport_unavailable"))
    const { result } = renderHook(() =>
      useRemoteDesktopSession(phoneHost, target, {
        open: jest
          .fn()
          .mockResolvedValue({ ...opened("s9"), transport: "companion", url: undefined }),
        renew: jest.fn(),
        close,
        openStream,
      })
    )
    await act(() => result.current.connect("view"))
    expect(close).toHaveBeenCalledWith(phoneHost, "s9")
    expect(result.current.state).toMatchObject({
      status: "ended",
      error: { code: "remote_desktop_transport_unavailable" },
    })
  })

  it("asks before taking control from someone else, then takes over", async () => {
    const open = jest
      .fn()
      .mockRejectedValueOnce(new Error("remote_desktop_control_busy"))
      .mockResolvedValueOnce(opened("s2"))
    const { result } = renderHook(() =>
      useRemoteDesktopSession(local, target, {
        open,
        renew: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
        openStream: streams().openStream,
      })
    )
    await act(() => result.current.connect("control"))
    expect(result.current.state.status).toBe("busy")
    await act(() => result.current.connect("control", true))
    expect(open).toHaveBeenLastCalledWith(local, {
      targetId: "t",
      bindingId: "b",
      mode: "control",
      takeover: true,
    })
    expect(result.current.state.status).toBe("open")
  })

  it("closes the previous session and stream before switching mode", async () => {
    const open = jest
      .fn()
      .mockResolvedValueOnce(opened("s1"))
      .mockResolvedValueOnce(opened("s2", "view"))
    const close = jest.fn().mockResolvedValue(undefined)
    const { openStream, closed } = streams()
    const { result } = renderHook(() =>
      useRemoteDesktopSession(local, target, { open, renew: jest.fn(), close, openStream })
    )
    await act(() => result.current.connect("control"))
    await act(() => result.current.connect("view"))
    expect(close).toHaveBeenCalledWith(local, "s1")
    expect(closed).toEqual(["s1"])
    expect(result.current.state.status === "open" && result.current.state.session.mode).toBe("view")
  })

  it("ends when renewal says control was taken", async () => {
    const renew = jest.fn().mockRejectedValue(new Error("remote_desktop_lease_lost"))
    const { openStream, closed } = streams()
    const { result } = renderHook(() =>
      useRemoteDesktopSession(local, target, {
        open: jest.fn().mockResolvedValue(opened("s1")),
        renew,
        close: jest.fn().mockResolvedValue(undefined),
        openStream,
        renewMs: 10,
      })
    )
    await act(() => result.current.connect("control"))
    await waitFor(() => expect(result.current.state.status).toBe("ended"))
    const state = result.current.state
    expect(state.status === "ended" && state.error?.code).toBe("remote_desktop_lease_lost")
    expect(closed).toEqual(["s1"])
  })

  it("reports open failures and explicit ends", async () => {
    const close = jest.fn().mockResolvedValue(undefined)
    const open = jest
      .fn()
      .mockRejectedValueOnce(new Error("remote_desktop_connect_failed"))
      .mockResolvedValueOnce(opened("s3"))
    const { result } = renderHook(() =>
      useRemoteDesktopSession(local, target, {
        open,
        renew: jest.fn(),
        close,
        openStream: streams().openStream,
      })
    )
    await act(() => result.current.connect("control"))
    expect(result.current.state).toMatchObject({
      status: "ended",
      error: { code: "remote_desktop_connect_failed" },
    })
    await act(() => result.current.connect("control"))
    act(() => result.current.markEnded(new RemoteDesktopError("remote_desktop_connection_lost")))
    expect(close).toHaveBeenCalledWith(local, "s3")
    expect(result.current.state).toMatchObject({
      status: "ended",
      error: { code: "remote_desktop_connection_lost" },
    })
    act(() => result.current.disconnect())
    expect(result.current.state).toEqual({ status: "ended" })
  })

  it("does nothing without a target or a Host", async () => {
    const open = jest.fn()
    const { result } = renderHook(() => useRemoteDesktopSession(local, null, { open }))
    await act(() => result.current.connect("control"))
    const { result: hostless } = renderHook(() => useRemoteDesktopSession(null, target, { open }))
    await act(() => hostless.current.connect("control"))
    expect(open).not.toHaveBeenCalled()
  })
})
