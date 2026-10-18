/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import {
  SANDBOX_STREAM_UNAVAILABLE,
  type SandboxStreamGrant,
} from "@/lib/automation/sandbox-client"

import { useSandboxDesktopStream } from "./use-sandbox-desktop-stream"

function viewer(id: string): SandboxStreamGrant {
  return { viewerId: id, url: `http://127.0.0.1:49000/?token=${id}`, role: "viewer" }
}

const lease = { token: "lease", fence: 3, expiresAt: Date.now() + 15_000 }

describe("useSandboxDesktopStream", () => {
  it("opens a viewer grant, claims control with the lease and closes on unmount", async () => {
    const open = jest.fn().mockResolvedValueOnce(viewer("v1"))
    const claim = jest.fn().mockResolvedValue({
      viewerId: "v1",
      url: "http://127.0.0.1:49000/?token=c",
      role: "controller",
    })
    const close = jest.fn().mockResolvedValue(undefined)
    const { result, unmount } = renderHook(() =>
      useSandboxDesktopStream("c1", true, { open, claim, close })
    )
    await waitFor(() => expect(result.current.grant?.viewerId).toBe("v1"))
    expect(result.current.status).toBe("open")
    let claimed = false
    await act(async () => {
      claimed = await result.current.claim(lease)
    })
    expect(claimed).toBe(true)
    expect(claim).toHaveBeenCalledWith("c1", "v1", "lease", 3)
    expect(result.current.grant?.role).toBe("controller")
    unmount()
    expect(close).toHaveBeenCalledWith("c1", "v1")
  })

  it("reports a sandbox without Selkies as unavailable and grants nothing", async () => {
    const open = jest
      .fn()
      .mockRejectedValue(new Error(`Backend error: ${SANDBOX_STREAM_UNAVAILABLE}`))
    const { result } = renderHook(() =>
      useSandboxDesktopStream("c1", true, { open, claim: jest.fn(), close: jest.fn() })
    )
    await waitFor(() => expect(result.current.status).toBe("unavailable"))
    expect(result.current.grant).toBeNull()
    await act(async () => {
      expect(await result.current.claim(lease)).toBe(false)
    })
  })

  it("reopens a fresh viewer after control ends and keeps the viewer when a claim fails", async () => {
    const open = jest.fn().mockResolvedValueOnce(viewer("v1")).mockResolvedValueOnce(viewer("v2"))
    const claim = jest.fn().mockRejectedValue(new Error("stream down"))
    const close = jest.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSandboxDesktopStream("c1", true, { open, claim, close }))
    await waitFor(() => expect(result.current.grant?.viewerId).toBe("v1"))
    await act(async () => {
      expect(await result.current.claim(lease)).toBe(false)
    })
    expect(result.current.grant?.viewerId).toBe("v1")
    await act(async () => {
      await result.current.reopen()
    })
    expect(close).toHaveBeenCalledWith("c1", "v1")
    expect(result.current.grant?.viewerId).toBe("v2")
  })

  it("closes a grant that arrives after it was disabled", async () => {
    let resolve: (grant: SandboxStreamGrant) => void = () => undefined
    const open = jest.fn().mockReturnValue(
      new Promise<SandboxStreamGrant>((done) => {
        resolve = done
      })
    )
    const close = jest.fn().mockResolvedValue(undefined)
    const { result, rerender } = renderHook(
      ({ enabled }) => useSandboxDesktopStream("c1", enabled, { open, claim: jest.fn(), close }),
      { initialProps: { enabled: true } }
    )
    await waitFor(() => expect(open).toHaveBeenCalled())
    rerender({ enabled: false })
    await act(async () => {
      resolve(viewer("late"))
    })
    expect(close).toHaveBeenCalledWith("c1", "late")
    expect(result.current.grant).toBeNull()
    expect(result.current.status).toBe("idle")
  })
})
