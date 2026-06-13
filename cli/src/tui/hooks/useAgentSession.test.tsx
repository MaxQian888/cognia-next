import { act, renderHook } from "@testing-library/react"

import { useAgentSession, type CreateSession } from "./useAgentSession"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import type { TuiAction } from "../state/types"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

const result = (): RunAndCaptureResult => ({
  text: "ok",
  messageId: "m",
  a2uiSurfaces: {},
  a2uiSurfaceOrder: [],
})

function harness(opts: { isLive?: boolean } = {}) {
  const actions: TuiAction[] = []
  const dispatch = (a: TuiAction) => actions.push(a)
  const send = jest.fn(async () => result())
  const close = jest.fn(async () => {})
  const setPermissionMode = jest.fn(async () => {})
  const create: CreateSession = jest.fn(() => ({
    sessionId: "s",
    send,
    close,
    setPermissionMode,
    isLive: () => opts.isLive ?? false,
  })) as unknown as CreateSession
  let sidecarHandler: ((p: unknown) => void) | null = null
  const subscribeSidecar = jest.fn((h: (p: unknown) => void) => {
    sidecarHandler = h
    return () => undefined
  })
  const requestCompact = jest.fn(async () => undefined)
  const { result: hook } = renderHook(() =>
    useAgentSession({ config, dispatch, createSession: create, subscribeSidecar, requestCompact })
  )
  return {
    actions,
    send,
    close,
    setPermissionMode,
    create,
    subscribeSidecar,
    requestCompact,
    fireSidecar: (p: unknown) => sidecarHandler?.(p),
    api: () => hook.current,
  }
}

describe("useAgentSession", () => {
  it("send drives a turn and lazily creates the session once", async () => {
    const h = harness()
    await act(async () => {
      await h.api().send("hi")
    })
    await act(async () => {
      await h.api().send("again")
    })
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.actions.map((a) => a.type)).toEqual([
      "TURN_START",
      "TURN_COMMIT",
      "TURN_START",
      "TURN_COMMIT",
    ])
  })

  it("clear closes the session and dispatches RESET", async () => {
    const h = harness()
    await act(async () => {
      await h.api().send("hi")
    })
    await act(async () => {
      await h.api().clear("ses-2")
    })
    expect(h.close).toHaveBeenCalled()
    expect(h.actions.at(-1)).toEqual({ type: "RESET", sessionId: "ses-2" })
  })

  it("switchModel and switchThinking dispatch and drop the session", async () => {
    const h = harness()
    await act(async () => {
      await h.api().send("hi")
    })
    await act(async () => {
      await h.api().switchModel("claude-y")
    })
    expect(h.actions).toContainEqual({ type: "SET_MODEL", model: "claude-y" })
    await act(async () => {
      await h.api().switchThinking("high")
    })
    expect(h.actions).toContainEqual({ type: "SET_THINKING", level: "high" })
    expect(h.close).toHaveBeenCalled()
  })

  it("switchMode mutates a LIVE session in place without dropping it (context preserved)", async () => {
    const h = harness({ isLive: true })
    await act(async () => {
      await h.api().send("hi")
    })
    await act(async () => {
      await h.api().switchMode("acceptEdits")
    })
    expect(h.actions).toContainEqual({ type: "SET_MODE", mode: "acceptEdits" })
    expect(h.setPermissionMode).toHaveBeenCalledWith("acceptEdits")
    // The session is NOT torn down — the in-process conversation survives.
    expect(h.close).not.toHaveBeenCalled()
  })

  it("switchMode before a session is live only dispatches (no control message, no drop)", async () => {
    const h = harness({ isLive: false })
    await act(async () => {
      await h.api().switchMode("plan")
    })
    expect(h.actions).toContainEqual({ type: "SET_MODE", mode: "plan" })
    expect(h.setPermissionMode).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
  })

  it("resume adopts a session id and loads its cells", async () => {
    const h = harness()
    await act(async () => {
      await h.api().resume("ses-old", [{ id: "r0", kind: "user", text: "old" }])
    })
    expect(h.create).toHaveBeenCalledWith({ config: expect.anything(), sessionId: "ses-old" })
    expect(h.actions).toContainEqual({ type: "RESET", sessionId: "ses-old" })
    expect(h.actions).toContainEqual({
      type: "LOAD_CELLS",
      cells: [{ id: "r0", kind: "user", text: "old" }],
    })
  })

  it("resolvePermission resolves the gate and closes the overlay", () => {
    const h = harness()
    act(() => {
      h.api().resolvePermission({ decision: "allow" })
    })
    expect(h.actions).toContainEqual({ type: "OVERLAY_CLOSE" })
  })

  it("compact notices when there is no live session yet", async () => {
    const h = harness({ isLive: false })
    await act(async () => {
      await h.api().send("hi") // creates the (non-live) session
    })
    await act(async () => {
      await h.api().compact("focus")
    })
    expect(h.requestCompact).not.toHaveBeenCalled()
    expect(h.actions).toContainEqual({
      type: "NOTICE",
      message: "Nothing to compact yet — send a message first.",
    })
  })

  it("compact sends the control message and renders the boundary on a live session", async () => {
    const h = harness({ isLive: true })
    await act(async () => {
      await h.api().send("hi")
    })
    await act(async () => {
      const pending = h.api().compact("the API changes")
      // The sidecar streams the boundary back on the event channel.
      h.fireSidecar({
        type: "event",
        sessionId: "s",
        event: {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 45_000, post_tokens: 8_000 },
        },
      })
      await pending
    })
    expect(h.requestCompact).toHaveBeenCalledWith("s", "the API changes")
    expect(h.actions).toContainEqual({
      type: "COMPACT_BOUNDARY",
      trigger: "manual",
      preTokens: 45_000,
      postTokens: 8_000,
    })
  })

  it("drops the session on turn error so the next send starts fresh", async () => {
    const h = harness()
    // First send succeeds — session is created lazily.
    await act(async () => {
      await h.api().send("hi")
    })
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.close).not.toHaveBeenCalled()
    // Make the next send throw so runTurn returns { ok: false }.
    h.send.mockRejectedValueOnce(new Error("session did not end within 300000ms"))
    await act(async () => {
      await h.api().send("crash")
    })
    expect(h.actions.at(-1)).toEqual({
      type: "TURN_ERROR",
      message: "session did not end within 300000ms",
    })
    // The stale session is dropped — close called, gate reset.
    expect(h.close).toHaveBeenCalled()
    // The next send creates a fresh session.
    h.send.mockResolvedValueOnce(result())
    await act(async () => {
      await h.api().send("recovery")
    })
    expect(h.create).toHaveBeenCalledTimes(2)
  })

  it("abort and close are safe to call", async () => {
    const h = harness()
    expect(() => h.api().abort()).not.toThrow()
    await act(async () => {
      await h.api().close()
    })
  })
})
