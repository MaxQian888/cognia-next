/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import {
  SANDBOX_STREAM_UNAVAILABLE,
  type SandboxStreamGrant,
} from "@/lib/automation/sandbox-client"

import { useSandboxDesktopStream } from "./use-sandbox-desktop-stream"

function viewer(id: string): SandboxStreamGrant {
  return {
    viewerId: id,
    url: `http://127.0.0.1:49000/?token=${id}`,
    role: "viewer",
    healthVersion: 1,
  }
}

const lease = { token: "lease", fence: 3, expiresAt: Date.now() + 15_000 }

describe("useSandboxDesktopStream", () => {
  it("opens a viewer grant, claims control with the lease and closes on unmount", async () => {
    const open = jest.fn().mockResolvedValueOnce(viewer("v1"))
    const claim = jest.fn().mockResolvedValue({
      viewerId: "v1",
      url: "http://127.0.0.1:49000/?token=c",
      role: "controller",
      healthVersion: 1,
    })
    const close = jest.fn().mockResolvedValue(undefined)
    const { result, unmount } = renderHook(() =>
      useSandboxDesktopStream("c1", true, { open, claim, close })
    )
    await waitFor(() => expect(result.current.grant?.viewerId).toBe("v1"))
    expect(result.current.status).toBe("connecting")
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

  it("reports a sandbox without Selkies as unavailable and lets polling keep control", async () => {
    const open = jest
      .fn()
      .mockRejectedValue(new Error(`Backend error: ${SANDBOX_STREAM_UNAVAILABLE}`))
    const claim = jest.fn()
    const { result } = renderHook(() =>
      useSandboxDesktopStream("c1", true, { open, claim, close: jest.fn() })
    )
    await waitFor(() => expect(result.current.status).toBe("unavailable"))
    expect(result.current.grant).toBeNull()
    // No stream to upgrade: the screenshot viewer carries the lease.
    await act(async () => {
      expect(await result.current.claim(lease)).toBe(true)
    })
    expect(claim).not.toHaveBeenCalled()
  })

  it("lets polling keep control when the stream failed to open", async () => {
    const open = jest.fn().mockRejectedValue(new Error("selkies crashed"))
    const { result } = renderHook(() =>
      useSandboxDesktopStream("c1", true, { open, claim: jest.fn(), close: jest.fn() })
    )
    await waitFor(() => expect(result.current.status).toBe("error"))
    await act(async () => {
      expect(await result.current.claim(lease)).toBe(true)
    })
  })

  it("does not let control through while the stream is still opening", async () => {
    const open = jest.fn(() => new Promise<never>(() => undefined))
    const claim = jest.fn()
    const { result } = renderHook(() =>
      useSandboxDesktopStream("c1", true, { open, claim, close: jest.fn() })
    )
    await waitFor(() => expect(result.current.status).toBe("opening"))
    await act(async () => {
      expect(await result.current.claim(lease)).toBe(false)
    })
    expect(claim).not.toHaveBeenCalled()
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

describe("stream media liveness and recovery", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.useRealTimers()
    document.body.replaceChildren()
    jest.restoreAllMocks()
  })

  async function tick(ms = 0) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms)
    })
  }

  async function mounted(
    beforeRecover = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)
  ) {
    const open = jest.fn().mockImplementation(async () => viewer(`v${open.mock.calls.length}`))
    const close = jest.fn().mockResolvedValue(undefined)
    const claim = jest
      .fn()
      .mockImplementation(async () => ({ ...viewer("controller"), role: "controller" }))
    const { result, unmount, rerender } = renderHook(
      ({ enabled }) =>
        useSandboxDesktopStream("c1", enabled, { open, close, claim }, beforeRecover),
      { initialProps: { enabled: true } }
    )
    const iframe = document.createElement("iframe")
    document.body.appendChild(iframe)
    result.current.attachFrame(iframe)
    const target = iframe.contentWindow!
    const post = jest.spyOn(target, "postMessage")
    await tick()
    const hello = () => post.mock.calls.at(-1)![0] as { nonce: string }
    const health = async (overrides = {}, eventOverrides = {}) => {
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: target,
            origin: "http://127.0.0.1:49000",
            data: {
              type: "cognia-sandbox-stream-health",
              version: 1,
              nonce: hello().nonce,
              connected: true,
              presented: true,
              failed: null,
              ...overrides,
            },
            ...eventOverrides,
          })
        )
      })
    }
    return {
      result,
      unmount,
      rerender,
      open,
      close,
      claim,
      beforeRecover,
      iframe,
      target,
      post,
      hello,
      health,
    }
  }

  it("requires the correct source, origin, nonce and schema before declaring media open", async () => {
    const model = await mounted()
    expect(model.result.current.status).toBe("connecting")
    await model.health({}, { source: window })
    await model.health({}, { origin: "http://attacker.invalid" })
    await model.health({ nonce: "old-grant-nonce" })
    await model.health({ version: 2 })
    await model.health({ presented: "yes" })
    await model.health({ failed: "unknown" })
    expect(model.result.current.status).toBe("connecting")
    await model.health({ presented: false })
    expect(model.result.current.status).toBe("connecting")
    await model.health()
    expect(model.result.current.status).toBe("open")
  })

  it("does not reconnect an idle display while authenticated heartbeats continue", async () => {
    const model = await mounted()
    await model.health()
    for (let cycle = 0; cycle < 8; cycle += 1) {
      await tick(5_000)
      await model.health()
    }
    expect(model.open).toHaveBeenCalledTimes(1)
    expect(model.beforeRecover).not.toHaveBeenCalled()
    expect(model.result.current.status).toBe("open")
  })

  it("times out before first output and retries view-only without claiming control", async () => {
    const model = await mounted()
    await model.health({ presented: false })
    await tick(15_000)
    expect(model.beforeRecover).toHaveBeenCalledTimes(1)
    expect(model.close).toHaveBeenCalledWith("c1", "v1")
    expect(model.result.current.grant).toBeNull()
    await tick(1_000)
    expect(model.open).toHaveBeenCalledTimes(2)
    expect(model.result.current.grant?.role).toBe("viewer")
    expect(model.claim).not.toHaveBeenCalled()
  })

  it("recovers when an established bridge stops answering", async () => {
    const model = await mounted()
    await model.health()
    await tick(15_000)
    expect(model.beforeRecover).toHaveBeenCalledTimes(1)
    expect(model.result.current.status).toBe("error")
  })

  it.each(["closed", "error", "decoder-failed", "decoder-stalled", "killed"])(
    "recovers view-only after the guest reports %s",
    async (failed) => {
      const model = await mounted()
      await model.health()
      await model.health({ failed })
      expect(model.beforeRecover).toHaveBeenCalledTimes(1)
      expect(model.result.current.grant).toBeNull()
      await tick(1_000)
      expect(model.result.current.grant?.role).toBe("viewer")
      expect(model.claim).not.toHaveBeenCalled()
    }
  )

  it("settles control before reopening and ignores late health from the previous grant", async () => {
    let settle!: () => void
    const beforeRecover = jest.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    )
    const model = await mounted(beforeRecover)
    const previousNonce = model.hello().nonce
    await model.health({ failed: "decoder-failed", connected: false })
    await tick(30_000)
    expect(model.open).toHaveBeenCalledTimes(1)
    expect(model.result.current.grant).toBeNull()
    await act(async () => {
      settle()
    })
    await tick(1_000)
    expect(model.open).toHaveBeenCalledTimes(2)
    await model.health({ nonce: previousNonce })
    expect(model.result.current.status).toBe("connecting")
    await model.health()
    expect(model.result.current.status).toBe("open")
  })

  it("suspends liveness deadlines while hidden and gives the bridge a fresh deadline on return", async () => {
    const hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(false)
    const model = await mounted()
    await model.health()
    hidden.mockReturnValue(true)
    await tick(60_000)
    expect(model.beforeRecover).not.toHaveBeenCalled()
    hidden.mockReturnValue(false)
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await tick(1_000)
    await model.health()
    expect(model.beforeRecover).not.toHaveBeenCalled()
  })

  it("cancels recovery on disable and never retries after unmount", async () => {
    const model = await mounted()
    await model.health({ failed: "closed", connected: false })
    model.rerender({ enabled: false })
    await tick(60_000)
    expect(model.open).toHaveBeenCalledTimes(1)
    expect(model.result.current.status).toBe("idle")
    model.unmount()
    await tick(60_000)
    expect(model.open).toHaveBeenCalledTimes(1)
  })

  it("resumes observation after re-enabling while an old control release is settling", async () => {
    let settle!: () => void
    const beforeRecover = jest.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    )
    const model = await mounted(beforeRecover)
    await model.health({ failed: "closed", connected: false })
    model.rerender({ enabled: false })
    model.rerender({ enabled: true })
    await tick()
    expect(model.open).toHaveBeenCalledTimes(1)
    await act(async () => {
      settle()
    })
    await tick(2_000)
    expect(model.open).toHaveBeenCalledTimes(2)
    expect(model.result.current.grant?.role).toBe("viewer")
    expect(model.claim).not.toHaveBeenCalled()
  })

  it("retries grant failures but pauses retry during explicit screenshot-mode control", async () => {
    const open = jest.fn().mockRejectedValue(new Error("stream temporarily down"))
    const close = jest.fn()
    const { result } = renderHook(() => useSandboxDesktopStream("c1", true, { open, close }))
    await tick()
    await tick(1_000)
    expect(open).toHaveBeenCalledTimes(2)
    await act(async () => {
      expect(await result.current.claim(lease)).toBe(true)
    })
    await tick(60_000)
    expect(open).toHaveBeenCalledTimes(2)
    await act(async () => {
      await result.current.reopen()
    })
    expect(open).toHaveBeenCalledTimes(3)
  })

  it("preserves an older stream that does not advertise the liveness protocol", async () => {
    const open = jest
      .fn()
      .mockResolvedValue({ viewerId: "legacy", url: viewer("legacy").url, role: "viewer" })
    const beforeRecover = jest.fn()
    const { result } = renderHook(() =>
      useSandboxDesktopStream(
        "c1",
        true,
        { open, close: jest.fn().mockResolvedValue(undefined) },
        beforeRecover
      )
    )
    const iframe = document.createElement("iframe")
    document.body.appendChild(iframe)
    result.current.attachFrame(iframe)
    await tick()
    expect(result.current.status).toBe("unmonitored")
    await tick(60_000)
    expect(open).toHaveBeenCalledTimes(1)
    expect(beforeRecover).not.toHaveBeenCalled()
    expect(result.current.grant?.viewerId).toBe("legacy")
  })

  it("does not retry when unmounted during a pending control settlement", async () => {
    let settle!: () => void
    const beforeRecover = jest.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    )
    const model = await mounted(beforeRecover)
    await model.health({ failed: "closed", connected: false })
    model.unmount()
    await act(async () => {
      settle()
    })
    await tick(60_000)
    expect(model.open).toHaveBeenCalledTimes(1)
    expect(model.close).toHaveBeenCalledTimes(1)
  })
})
