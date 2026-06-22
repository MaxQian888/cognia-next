import { act, renderHook } from "@testing-library/react"

import { useAgentSession, type CreateSession } from "./useAgentSession"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { CapturePermissionDecision, RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import { RunAndCaptureError } from "@/lib/claude/run-and-capture"
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
  // Inject a fake checkpoint capture so tests never touch the real on-disk store.
  const restore = jest.fn()
  const checkpoints = [
    { seq: 1, label: "first prompt", ts: 1, cellCount: 1, files: [{ absPath: "/a" }] },
  ]
  const capture = {
    beginTurn: jest.fn(),
    onToolCall: jest.fn(),
    list: jest.fn(() => checkpoints),
    store: { restore },
  }
  const createCheckpoints = jest.fn(() => capture as never)
  const { result: hook } = renderHook(() =>
    useAgentSession({
      config,
      dispatch,
      createSession: create,
      subscribeSidecar,
      requestCompact,
      createCheckpoints,
    })
  )
  return {
    actions,
    send,
    close,
    setPermissionMode,
    create,
    subscribeSidecar,
    requestCompact,
    capture,
    restore,
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

  it("interactive turns disable the wall-clock cap (timeoutMs: 0)", async () => {
    // An interactive agentic turn can run for many minutes; the 5-minute
    // wall-clock that run-and-capture defaults to (for headless/connector runs)
    // would kill it mid-progress. The TUI must opt out and rely on the idle
    // watchdog + per-tool deadline instead.
    const h = harness()
    await act(async () => {
      await h.api().send("hi")
    })
    expect(h.send).toHaveBeenCalledWith("hi", expect.objectContaining({ timeoutMs: 0 }))
  })

  it("folds a usage_headers message into a SET_RATE_LIMITS action", () => {
    const h = harness()
    act(() => {
      h.fireSidecar({
        type: "usage_headers",
        headers: {
          "anthropic-ratelimit-requests-limit": "100",
          "anthropic-ratelimit-requests-remaining": "40",
        },
      })
    })
    const rl = h.actions.find((a) => a.type === "SET_RATE_LIMITS")
    expect(rl).toBeDefined()
    expect(rl).toMatchObject({ snapshot: { meters: [{ kind: "requests", usedPct: 60 }] } })
  })

  it("ignores non-usage_headers and unparseable header payloads", () => {
    const h = harness()
    act(() => {
      h.fireSidecar({ type: "event", foo: 1 })
      h.fireSidecar({ type: "usage_headers", headers: null })
      h.fireSidecar({ type: "usage_headers", headers: { "x-other": "1" } })
      h.fireSidecar("not-an-object")
    })
    expect(h.actions.some((a) => a.type === "SET_RATE_LIMITS")).toBe(false)
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

  it("auto-approves a persisted tool through the gate without opening the overlay", async () => {
    const actions: TuiAction[] = []
    const dispatch = (a: TuiAction) => actions.push(a)
    let decision: CapturePermissionDecision | undefined
    const send = jest.fn(
      async (_p: string, opts: { gate: (r: unknown) => Promise<CapturePermissionDecision> }) => {
        decision = await opts.gate({ toolName: "mcp__cognia-tools__bash", input: {} })
        return result()
      }
    )
    const create = jest.fn(() => ({
      sessionId: "s",
      send,
      close: jest.fn(async () => {}),
      isLive: () => false,
    })) as unknown as CreateSession
    const capture = {
      beginTurn: jest.fn(),
      onToolCall: jest.fn(),
      list: jest.fn(() => []),
      store: { restore: jest.fn() },
    }
    const { result: hook } = renderHook(() =>
      useAgentSession({
        config,
        dispatch,
        createSession: create,
        subscribeSidecar: () => () => undefined,
        requestCompact: jest.fn(async () => undefined),
        createCheckpoints: () => capture as never,
        resolveApprovedTools: () => new Set(["mcp__cognia-tools__bash"]),
      })
    )
    await act(async () => {
      await hook.current.send("hi")
    })
    expect(decision).toEqual({ decision: "allow" })
    expect(actions.some((a) => a.type === "OVERLAY_OPEN")).toBe(false)
  })

  it("rememberApproval makes a later request to the same tool auto-approve", async () => {
    const actions: TuiAction[] = []
    const dispatch = (a: TuiAction) => actions.push(a)
    let decision: CapturePermissionDecision | undefined
    const send = jest.fn(
      async (_p: string, opts: { gate: (r: unknown) => Promise<CapturePermissionDecision> }) => {
        decision = await opts.gate({ toolName: "Edit", input: {} })
        return result()
      }
    )
    const create = jest.fn(() => ({
      sessionId: "s",
      send,
      close: jest.fn(async () => {}),
      isLive: () => false,
    })) as unknown as CreateSession
    const capture = {
      beginTurn: jest.fn(),
      onToolCall: jest.fn(),
      list: jest.fn(() => []),
      store: { restore: jest.fn() },
    }
    const { result: hook } = renderHook(() =>
      useAgentSession({
        config,
        dispatch,
        createSession: create,
        subscribeSidecar: () => () => undefined,
        requestCompact: jest.fn(async () => undefined),
        createCheckpoints: () => capture as never,
        resolveApprovedTools: () => new Set(),
      })
    )
    act(() => {
      hook.current.rememberApproval("Edit")
    })
    await act(async () => {
      await hook.current.send("hi")
    })
    expect(decision).toEqual({ decision: "allow" })
    expect(actions.some((a) => a.type === "OVERLAY_OPEN")).toBe(false)
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

  it("drops the session on a NON-recoverable error (dead sidecar) so the next send respawns", async () => {
    const h = harness()
    // First send succeeds — session is created lazily.
    await act(async () => {
      await h.api().send("hi")
    })
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.close).not.toHaveBeenCalled()
    // A dead sidecar is unrecoverable → runTurn returns { ok: false, recoverable: false }.
    h.send.mockRejectedValueOnce(new RunAndCaptureError("sidecar exited mid-run", "sidecar_exited"))
    await act(async () => {
      await h.api().send("crash")
    })
    expect(h.actions.at(-1)).toEqual({
      type: "TURN_ERROR",
      message: "sidecar exited mid-run",
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

  it("KEEPS the session on a recoverable error (idle/timeout) so context survives", async () => {
    const h = harness()
    await act(async () => {
      await h.api().send("hi")
    })
    expect(h.create).toHaveBeenCalledTimes(1)
    // A recoverable session_error (idle watchdog / timeout / provider error)
    // leaves the multi-turn session alive — it must NOT be dropped.
    h.send.mockRejectedValueOnce(new RunAndCaptureError("stream idle for 60000ms", "session_error"))
    await act(async () => {
      await h.api().send("stall")
    })
    expect(h.actions.at(-1)).toEqual({
      type: "TURN_ERROR",
      message: "stream idle for 60000ms",
    })
    expect(h.close).not.toHaveBeenCalled() // session kept
    // The next message REUSES the same session (no respawn → still one create).
    h.send.mockResolvedValueOnce(result())
    await act(async () => {
      await h.api().send("continue")
    })
    expect(h.create).toHaveBeenCalledTimes(1)
  })

  it("abort and close are safe to call", async () => {
    const h = harness()
    expect(() => h.api().abort()).not.toThrow()
    await act(async () => {
      await h.api().close()
    })
  })

  it("listCheckpoints maps the capture's checkpoints", () => {
    const h = harness()
    expect(h.api().listCheckpoints()).toEqual([
      { seq: 1, label: "first prompt", ts: 1, cellCount: 1, fileCount: 1 },
    ])
  })

  it("rewind files restores the file shadows without touching the conversation", async () => {
    const h = harness()
    await act(async () => {
      await h.api().rewind(1, "files", [])
    })
    expect(h.restore).toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }), {
      files: true,
      conversation: false,
    })
    expect(h.actions.some((a) => a.type === "LOAD_CELLS")).toBe(false)
  })

  it("rewind conversation truncates cells and reloads them on a live session", async () => {
    const h = harness()
    await act(async () => {
      await h.api().send("hi") // create the session so a sessionId exists
    })
    const cells = [
      { id: "1", kind: "user", text: "a" },
      { id: "2", kind: "assistant", raw: "b" },
    ] as never
    await act(async () => {
      await h.api().rewind(1, "conversation", cells)
    })
    // cellCount 1 → only the first cell is kept.
    expect(h.actions).toContainEqual({ type: "LOAD_CELLS", cells: [cells[0]] })
  })

  it("rewind notices when the checkpoint is missing", async () => {
    const h = harness()
    await act(async () => {
      await h.api().rewind(99, "both", [])
    })
    expect(h.actions).toContainEqual({ type: "NOTICE", message: "Checkpoint #99 not found." })
  })
})
