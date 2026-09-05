import { act, renderHook, waitFor } from "@testing-library/react"

import { sessionRestartNotice, useAgentSession, type CreateSession } from "./useAgentSession"
import type { SendTurnOptions } from "../../agent/session-runner"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import type { CapturePermissionDecision, RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import { RunAndCaptureError } from "@/lib/claude/run-and-capture"
import type { HookRunner } from "../runtime/hook-runner"
import type { TuiAction } from "../state/types"
import type {
  AgentEventEnvelope,
  ResolvedAgentExecutionSpec,
} from "@cognia/agent-config-types/agent-execution"

let nativeCheckpointFlag = false
jest.mock("@/lib/ai/agent/execution/feature-flags", () => ({
  getAgentExecutionFlags: () => ({ claudeSdkCheckpoint: nativeCheckpointFlag }),
}))

const handleRewindFiles = jest.fn()
const handleCancel = jest.fn(async () => undefined)
const createAgentExecutionHandle = jest.fn(
  (sessionId: string, spec: ResolvedAgentExecutionSpec, _transport?: unknown) => ({
    sessionId,
    spec,
    cancel: handleCancel,
    compact: jest.fn(async () => undefined),
    setModel: jest.fn(async () => undefined),
    setPermissionMode: jest.fn(async () => undefined),
    stopTask: jest.fn(async () => undefined),
    reinitialize: jest.fn(async () => undefined),
    rewindFiles: (messageId: string, options?: { dryRun?: boolean }) =>
      handleRewindFiles(messageId, options),
  })
)
jest.mock("@/lib/ai/agent/execution/agent-execution-handle", () => ({
  createAgentExecutionHandle: (
    sessionId: string,
    spec: ResolvedAgentExecutionSpec,
    transport?: unknown
  ) => createAgentExecutionHandle(sessionId, spec, transport),
  FrozenModelBindingError: class FrozenModelBindingError extends Error {},
}))

/** A spyable no-op HookRunner so tests can assert lifecycle-event firing. */
function spyHookRunner(): jest.Mocked<HookRunner> {
  return {
    onCapture: jest.fn(),
    onStop: jest.fn(),
    onPrompt: jest.fn(),
    preToolUse: jest.fn(async (_toolName: string, _input: unknown) => ({ deny: false })),
    onSessionStart: jest.fn(),
    onSessionEnd: jest.fn(),
    onPermissionRequest: jest.fn(),
    onPermissionDenied: jest.fn(),
  }
}

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

const result = (): RunAndCaptureResult => ({
  text: "ok",
  messageId: "m",
  a2uiSurfaces: {},
  a2uiSurfaceOrder: [],
})

function harness(
  opts: {
    isLive?: boolean
    sessionId?: string
    hooks?: HookRunner
    /** Custom `session.send` — receives the gate responder so a test can simulate
     * a mid-turn tool permission request. */
    sendImpl?: (prompt: string, options: SendTurnOptions) => Promise<unknown>
    /** Make session creation itself fail (e.g. an unknown `--backend` id). */
    createError?: Error
    resolvedSpec?: ResolvedAgentExecutionSpec
    canonicalEnvelopes?: AgentEventEnvelope[]
  } = {}
) {
  const actions: TuiAction[] = []
  const dispatch = (a: TuiAction) => actions.push(a)
  let resolveExecution: ((spec: ResolvedAgentExecutionSpec) => void) | undefined
  const sendImpl: (prompt: string, options: SendTurnOptions) => Promise<unknown> =
    opts.sendImpl ??
    (async (_prompt, sendOptions) => {
      if (opts.resolvedSpec) resolveExecution?.(opts.resolvedSpec)
      for (const envelope of opts.canonicalEnvelopes ?? []) sendOptions.onEnvelope?.(envelope)
      return result()
    })
  const send = jest.fn(sendImpl)
  const close = jest.fn(async () => {})
  const setPermissionMode = jest.fn(async () => {})
  const create: CreateSession = jest.fn((params) => {
    if (opts.createError) throw opts.createError
    resolveExecution = params.onResolvedExecutionSpec
    return {
      sessionId: "s",
      send,
      close,
      setPermissionMode,
      isLive: () => opts.isLive ?? false,
    }
  }) as unknown as CreateSession
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
  // Inject an off-disk MCP-log file sink so the `mcp_log`/`log` capture branch
  // never writes to the real `~/.cognia/logs/mcp.log` in tests.
  const appendMcpLog = jest.fn()
  const { result: hook } = renderHook(() =>
    useAgentSession({
      config,
      dispatch,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      createSession: create,
      subscribeSidecar,
      requestCompact,
      createCheckpoints,
      appendMcpLog,
      ...(opts.hooks ? { createHooks: () => opts.hooks as HookRunner } : {}),
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
    appendMcpLog,
    fireSidecar: (p: unknown) => sidecarHandler?.(p),
    resolveExecution: (spec: ResolvedAgentExecutionSpec) => resolveExecution?.(spec),
    api: () => hook.current,
  }
}

function nativeSpec(): ResolvedAgentExecutionSpec {
  return {
    specVersion: 2,
    identity: {
      sessionId: "s",
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
    },
    executionFingerprint: "fp-native",
    executionKind: "agent",
    fallbackPolicy: "none",
    runtimeAdapter: "claude-agent-sdk",
    runtimePolicySource: "explicit",
    modelBindings: { primary: "sonnet" },
    route: { kind: "direct", routePolicy: "direct" },
    hostRef: "desktop-sidecar",
    compatibility: { evidence: "native" },
    capabilities: {
      effective: ["checkpoint"],
      disabledOptional: [],
      support: { checkpoint: { support: "native", reason: "test" } },
    },
  }
}

function userReplayEnvelope(): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: "s:turn-1:attempt-1:0",
    sessionId: "s",
    runId: "run-1",
    turnId: "turn-1",
    attemptId: "attempt-1",
    sequence: 0,
    timestamp: "2026-08-10T00:00:00.000Z",
    hostRef: "desktop-sidecar",
    runtime: "claude-agent-sdk",
    event: { kind: "user-replay", messageId: "user-message-1", preview: "Native prompt" },
  }
}

describe("useAgentSession", () => {
  beforeEach(() => {
    nativeCheckpointFlag = false
    createAgentExecutionHandle.mockClear()
    handleCancel.mockClear()
    handleRewindFiles.mockReset().mockResolvedValue({ status: "ready", paths: ["/a"] })
  })
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

  it("binds the lazily-created session to the app session id (so /export finds the transcript)", async () => {
    // Without this binding the runner mints its OWN id and writes the transcript
    // there, while /export reads under the app id → "no turns".
    const h = harness({ sessionId: "app-session-1" })
    await act(async () => {
      await h.api().send("hi")
    })
    expect(h.create).toHaveBeenCalledWith({
      config: expect.anything(),
      sessionId: "app-session-1",
      onResolvedExecutionSpec: expect.any(Function),
    })
  })

  it("omits sessionId when the app id is unknown (runner mints its own)", async () => {
    const h = harness()
    await act(async () => {
      await h.api().send("hi")
    })
    expect(h.create).toHaveBeenCalledWith({
      config: expect.anything(),
      onResolvedExecutionSpec: expect.any(Function),
    })
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

  it("captures an mcp_log event into MCP_LOG_APPEND and the file sink", () => {
    const h = harness()
    act(() => {
      h.fireSidecar({
        type: "mcp_log",
        ts: 5,
        level: "info",
        source: "stderr",
        server: "github",
        message: "connected",
      })
    })
    const appended = h.actions.find((a) => a.type === "MCP_LOG_APPEND")
    expect(appended).toMatchObject({
      entry: { level: "info", server: "github", message: "connected", source: "stderr" },
    })
    expect(h.appendMcpLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: "connected", server: "github" })
    )
  })

  it("captures the generic sidecar log stream tagged source=sidecar", () => {
    const h = harness()
    act(() => {
      h.fireSidecar({ type: "log", level: "warn", message: "hook slow" })
    })
    expect(h.actions.find((a) => a.type === "MCP_LOG_APPEND")).toMatchObject({
      entry: { level: "warn", message: "hook slow", source: "sidecar" },
    })
  })

  it("raises a throttled error toast on an mcp_log error (once per burst)", () => {
    const h = harness()
    act(() => {
      h.fireSidecar({
        type: "mcp_log",
        level: "error",
        source: "stderr",
        server: "db",
        message: "boom",
      })
      h.fireSidecar({
        type: "mcp_log",
        level: "error",
        source: "stderr",
        server: "db",
        message: "again",
      })
    })
    const toasts = h.actions.filter(
      (a) => a.type === "TOAST_PUSH" && a.message === 'MCP server "db" error'
    )
    // Both lines are captured, but only ONE toast fires for the burst.
    expect(h.actions.filter((a) => a.type === "MCP_LOG_APPEND")).toHaveLength(2)
    expect(toasts).toHaveLength(1)
  })

  it("does not toast for a non-error mcp_log or a generic sidecar log", () => {
    const h = harness()
    act(() => {
      h.fireSidecar({ type: "mcp_log", level: "warn", source: "stderr", message: "slow" })
      h.fireSidecar({ type: "log", level: "error", message: "internal only" })
    })
    expect(h.actions.some((a) => a.type === "TOAST_PUSH")).toBe(false)
  })

  it("surfaces a sidecar_exited event as SIDECAR_STATUS + an error toast", () => {
    const h = harness()
    act(() => {
      h.fireSidecar({ type: "sidecar_exited" })
    })
    expect(h.actions).toContainEqual({ type: "SIDECAR_STATUS", down: true })
    const toast = h.actions.find((a) => a.type === "TOAST_PUSH")
    expect(toast).toMatchObject({ severity: "error", message: "Agent backend stopped" })
  })

  it("fires SessionStart when the session is lazily created", async () => {
    const hooks = spyHookRunner()
    const h = harness({ hooks })
    await act(async () => {
      await h.api().send("hi")
    })
    expect(hooks.onSessionStart).toHaveBeenCalledTimes(1)
    // A second send reuses the session — no second SessionStart.
    await act(async () => {
      await h.api().send("again")
    })
    expect(hooks.onSessionStart).toHaveBeenCalledTimes(1)
  })

  it("fires SessionEnd on /clear (drop + reset)", async () => {
    const hooks = spyHookRunner()
    const h = harness({ hooks })
    await act(async () => {
      await h.api().send("hi")
    })
    await act(async () => {
      await h.api().clear("new-session")
    })
    expect(hooks.onSessionEnd).toHaveBeenCalledTimes(1)
  })

  it("fires PermissionRequest on a tool ask and PermissionDenied on deny", async () => {
    const hooks = spyHookRunner()
    const h = harness({
      hooks,
      sendImpl: async (_p, o) => {
        // Simulate the model requesting a tool mid-turn (fire-and-forget; the
        // gate promise resolves when the UI later calls resolvePermission).
        void o.gate({
          type: "permission_request",
          sessionId: "s",
          requestId: "req-1",
          toolUseID: "tool-1",
          toolName: "Bash",
          input: { command: "rm -rf build" },
        })
        return result()
      },
    })
    await act(async () => {
      await h.api().send("clean up")
    })
    expect(hooks.onPermissionRequest).toHaveBeenCalledWith("Bash", { command: "rm -rf build" })
    act(() => h.api().resolvePermission({ decision: "deny", message: "nope" }))
    expect(hooks.onPermissionDenied).toHaveBeenCalledWith("Bash", "nope")
  })

  it("runs a read-only shell command without asking anybody", async () => {
    const hooks = spyHookRunner()
    let decision: unknown
    const h = harness({
      hooks,
      sendImpl: async (_p, o) => {
        decision = await o.gate({
          type: "permission_request",
          sessionId: "s",
          requestId: "req-1",
          toolUseID: "tool-1",
          toolName: "Bash",
          input: { command: "ls -la packages" },
        })
        return result()
      },
    })
    await act(async () => {
      await h.api().send("what is in packages")
    })
    // `bash` is one tool rated by its worst possible use, so this used to open
    // the same "[high risk]" prompt as `rm -rf /`.
    expect(decision).toEqual({ decision: "allow" })
    expect(hooks.onPermissionRequest).not.toHaveBeenCalled()
  })

  it("raises a rate-limit toast when a meter crosses crit, de-duped per level", () => {
    const h = harness()
    const critHeaders = {
      "anthropic-ratelimit-requests-limit": "100",
      "anthropic-ratelimit-requests-remaining": "5", // 95% used → crit
    }
    act(() => h.fireSidecar({ type: "usage_headers", headers: critHeaders }))
    const first = h.actions.filter((a) => a.type === "TOAST_PUSH")
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      severity: "warn",
      message: expect.stringMatching(/Approaching/),
    })
    // A second reading at the same crit level must NOT re-toast.
    act(() => h.fireSidecar({ type: "usage_headers", headers: critHeaders }))
    expect(h.actions.filter((a) => a.type === "TOAST_PUSH")).toHaveLength(1)
    // Escalating to exceeded toasts again (a new, more severe level).
    act(() =>
      h.fireSidecar({
        type: "usage_headers",
        headers: { ...critHeaders, "anthropic-ratelimit-requests-remaining": "0" },
      })
    )
    const all = h.actions.filter((a) => a.type === "TOAST_PUSH")
    expect(all).toHaveLength(2)
    expect(all[1]).toMatchObject({ severity: "error" })
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

  it("clear mid-turn aborts the in-flight turn (clean interrupt, no stray error cell)", async () => {
    // /clear bypasses the busy gate, so it can fire while a turn streams. Killing
    // the sidecar from under a live capture must route through the abort path
    // (TURN_ABORTED) not the error path (TURN_ERROR), and the RESET must wipe it.
    const actions: TuiAction[] = []
    const dispatch = (a: TuiAction) => actions.push(a)
    let capturedSignal: AbortSignal | undefined
    const send = jest.fn(
      (_p: string, opts: { signal?: AbortSignal }) =>
        new Promise<RunAndCaptureResult>((_resolve, reject) => {
          capturedSignal = opts.signal
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })
    )
    const create = jest.fn(() => ({
      sessionId: "s",
      send,
      close: jest.fn(async () => {}),
      isLive: () => true,
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
      })
    )
    let turn: Promise<unknown>
    await act(async () => {
      turn = hook.current.send("hi") // hangs until aborted
      await Promise.resolve()
    })
    await act(async () => {
      await hook.current.clear("ses-2")
      await turn
    })
    expect(capturedSignal?.aborted).toBe(true)
    const types = actions.map((a) => a.type)
    expect(types).toContain("TURN_ABORTED")
    expect(types).not.toContain("TURN_ERROR")
    expect(actions.at(-1)).toEqual({ type: "RESET", sessionId: "ses-2" })
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

  it("changeCwd dispatches SET_CWD and drops the session so the next turn relocates", async () => {
    const h = harness()
    await act(async () => {
      await h.api().send("hi")
    })
    await act(async () => {
      await h.api().changeCwd("/new/dir")
    })
    expect(h.actions).toContainEqual({ type: "SET_CWD", cwd: "/new/dir" })
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

  it("commits a live mode only after acknowledgement and preserves it after refusal", async () => {
    const h = harness({ isLive: true })
    await act(async () => {
      await h.api().send("hi")
    })
    let acknowledge!: () => void
    h.setPermissionMode.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve
        })
    )
    let switching!: Promise<void>
    await act(async () => {
      switching = h.api().switchMode("plan")
    })
    expect(h.actions).not.toContainEqual({ type: "SET_MODE", mode: "plan" })
    await act(async () => {
      acknowledge()
      await switching
    })
    expect(h.actions).toContainEqual({ type: "SET_MODE", mode: "plan" })
    h.setPermissionMode.mockRejectedValueOnce(new Error("SDK refused"))
    await act(async () => {
      await h.api().switchMode("acceptEdits")
    })
    expect(h.actions).not.toContainEqual({ type: "SET_MODE", mode: "acceptEdits" })
    expect(h.actions).toContainEqual({
      type: "NOTICE",
      message: "Permission mode unchanged: SDK refused",
    })
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
    expect(h.create).toHaveBeenCalledWith({
      config: expect.anything(),
      sessionId: "ses-old",
      onResolvedExecutionSpec: expect.any(Function),
    })
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

  it("rechecks persisted grants after revocation in the same live session", async () => {
    const grants = new Set(["Edit"])
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
        resolveApprovedTools: () => grants,
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
    grants.clear()
    let pending: Promise<RunAndCaptureResult | null>
    act(() => {
      pending = hook.current.send("after revoke")
    })
    await waitFor(() => expect(actions.some((a) => a.type === "OVERLAY_OPEN")).toBe(true))
    await act(async () => {
      hook.current.denyPendingPermissions("revoked")
      await pending!
    })
    expect(decision?.decision).toBe("deny")
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
    expect(h.actions).toContainEqual(
      expect.objectContaining({
        type: "TURN_ERROR",
        message: "sidecar exited mid-run",
        category: "sidecar",
      })
    )
    // …and the drop is announced permanently: the transcript above still shows
    // the whole conversation, but the respawned agent can no longer see it.
    expect(h.actions.at(-1)).toMatchObject({
      type: "NOTICE",
      message: expect.stringContaining("no longer visible") as unknown as string,
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

  it("surfaces a session that fails to be CREATED instead of swallowing the prompt", async () => {
    // e.g. `cognia-agent chat --backend cdoex` — the factory throws synchronously,
    // outside the turn engine's try, so the message used to vanish silently.
    const h = harness({ createError: new Error("Unknown external-agent backend: cdoex") })

    await act(async () => {
      await h.api().send("hi")
    })

    expect(h.actions.at(-1)).toMatchObject({
      type: "TURN_ERROR",
      message: "Unknown external-agent backend: cdoex",
    })
    expect(h.send).not.toHaveBeenCalled()
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
    expect(h.actions.at(-1)).toMatchObject({
      type: "TURN_ERROR",
      message: "stream idle for 60000ms",
      category: "timeout",
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

  it("uses native user-replay checkpoints exclusively when the frozen session enables them", async () => {
    nativeCheckpointFlag = true
    const h = harness({
      resolvedSpec: nativeSpec(),
      canonicalEnvelopes: [userReplayEnvelope()],
    })
    await act(async () => {
      await h.api().send("Native prompt")
    })

    expect(h.capture.onToolCall).not.toHaveBeenCalled()
    expect(h.api().listCheckpoints()).toEqual([
      expect.objectContaining({ seq: 0, label: "Native prompt", fileCount: 0 }),
    ])

    await act(async () => {
      await h.api().rewind(0, "both", [])
    })
    expect(handleRewindFiles).toHaveBeenCalledWith("user-message-1", { dryRun: false })
    expect(h.restore).not.toHaveBeenCalled()
    expect(h.actions).toContainEqual(
      expect.objectContaining({
        type: "NOTICE",
        message: expect.stringContaining("conversation history was not changed"),
      })
    )
  })

  it("freezes the first resolved execution handle for the live session", async () => {
    const h = harness()
    await act(async () => {
      await h.api().send("start")
    })
    const first = nativeSpec()
    const changed = { ...first, executionFingerprint: "fp-changed" }
    act(() => {
      h.resolveExecution(first)
      h.resolveExecution(changed)
    })

    expect(createAgentExecutionHandle).toHaveBeenCalledTimes(1)
    expect(createAgentExecutionHandle).toHaveBeenCalledWith("s", first, expect.any(Object))
  })

  it("keeps external-agent controls on the existing AgentSession transport", () => {
    const h = harness()
    const externalSpec = { ...nativeSpec(), runtimeAdapter: "external" as const }

    act(() => h.resolveExecution(externalSpec))

    expect(createAgentExecutionHandle).not.toHaveBeenCalled()
  })

  it("forkConversationAt truncates to the kept cells and re-mints the session", async () => {
    const h = harness()
    await act(async () => {
      await h.api().send("hi") // create the session so a sessionId exists
    })
    const cells = [
      { id: "1", kind: "user", text: "a" },
      { id: "2", kind: "assistant", raw: "b" },
      { id: "3", kind: "user", text: "c" },
    ] as never
    await act(async () => {
      await h.api().forkConversationAt(2, cells)
    })
    // Keeps the first two cells, drops the rest, and resets onto the same id.
    expect(h.actions).toContainEqual({ type: "LOAD_CELLS", cells: [cells[0], cells[1]] })
    expect(h.actions.some((a) => a.type === "RESET")).toBe(true)
    // The session is re-minted (initial create + the fork's create).
    expect((h.create as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("forkConversationAt is a no-op without an active session", async () => {
    const h = harness()
    await act(async () => {
      await h.api().forkConversationAt(0, [])
    })
    expect(h.actions.some((a) => a.type === "LOAD_CELLS")).toBe(false)
  })
})

describe("sessionRestartNotice", () => {
  it("names the external backend whose memory was actually lost", () => {
    expect(sessionRestartNotice({ ...config, agentBackend: "codex" })).toContain("codex")
  })

  it("falls back to a generic subject on the built-in backend", () => {
    expect(sessionRestartNotice(config)).toContain("the agent")
    expect(sessionRestartNotice({ ...config, agentBackend: undefined })).toContain("the agent")
  })
})
