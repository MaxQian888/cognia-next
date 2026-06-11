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

function harness() {
  const actions: TuiAction[] = []
  const dispatch = (a: TuiAction) => actions.push(a)
  const send = jest.fn(async () => result())
  const close = jest.fn(async () => {})
  const create: CreateSession = jest.fn(() => ({
    sessionId: "s",
    send,
    close,
  })) as unknown as CreateSession
  const { result: hook } = renderHook(() =>
    useAgentSession({ config, dispatch, createSession: create })
  )
  return { actions, send, close, create, api: () => hook.current }
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

  it("switchModel and switchMode dispatch and drop the session", async () => {
    const h = harness()
    await act(async () => {
      await h.api().send("hi")
    })
    await act(async () => {
      await h.api().switchModel("claude-y")
    })
    expect(h.actions).toContainEqual({ type: "SET_MODEL", model: "claude-y" })
    await act(async () => {
      await h.api().switchMode("plan")
    })
    expect(h.actions).toContainEqual({ type: "SET_MODE", mode: "plan" })
    await act(async () => {
      await h.api().switchThinking("high")
    })
    expect(h.actions).toContainEqual({ type: "SET_THINKING", level: "high" })
    expect(h.close).toHaveBeenCalled()
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

  it("abort and close are safe to call", async () => {
    const h = harness()
    expect(() => h.api().abort()).not.toThrow()
    await act(async () => {
      await h.api().close()
    })
  })
})
