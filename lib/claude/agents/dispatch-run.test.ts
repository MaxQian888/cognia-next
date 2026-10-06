import { startDispatchRun, resolveCaller, loadNesting, type ResolvedCaller } from "./dispatch-run"
import { dispatchSubagent } from "@/lib/plugin/agent-sdk/dispatch"
import { getDispatchableSubagentDef } from "@/lib/claude/agents/subagents"
import { getSettings } from "@/lib/db/settings"
import { getSession } from "@/lib/db/sessions"
import { resolveSessionCwd } from "@/lib/workspace/session-cwd"
import {
  journalRendererForegroundRun,
  startAcceptedRendererBackgroundRun,
} from "@/lib/background-tasks/renderer-subagent-registry"
import {
  registerDispatchContext,
  __clearAllDispatchContextsForTesting,
} from "./dispatch-context-registry"
import { __clearAllDispatchBudgetsForTesting, getOrCreateDispatchBudget } from "./dispatch-budget"
import { requestCancelSubagentRun, liveSubagentRunCount } from "./subagent-cancel-registry"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { PluginSubagentDispatchResult } from "@/types/plugin/plugin-agent-sdk"
import {
  registerKnowledgeAccessForSession,
  clearKnowledgeReaderForSession,
} from "@/lib/knowledge-base/runtime/session-reader"

jest.mock("@/lib/plugin/agent-sdk/dispatch", () => ({
  __esModule: true,
  dispatchSubagent: jest.fn(),
}))
jest.mock("@/lib/claude/agents/subagents", () => ({
  __esModule: true,
  getDispatchableSubagentDef: jest.fn(),
}))
jest.mock("@/lib/db/settings", () => ({
  __esModule: true,
  getSettings: jest.fn(),
}))
jest.mock("@/lib/db/sessions", () => ({
  __esModule: true,
  getSession: jest.fn(),
}))
jest.mock("@/lib/workspace/session-cwd", () => ({
  __esModule: true,
  resolveSessionCwd: jest.fn(async () => undefined),
}))
jest.mock("@/lib/background-tasks/renderer-subagent-registry", () => ({
  __esModule: true,
  journalRendererForegroundRun: jest.fn(),
  startAcceptedRendererBackgroundRun: jest.fn(),
}))

const mockAdmission = jest.fn(async () => ({
  journal: { recordStart: jest.fn(), recordSettle: jest.fn() },
  markDispatched: jest.fn(async (): Promise<void> => undefined),
  requestCancel: jest.fn(async (): Promise<void> => undefined),
}))
jest.mock("@/lib/db/background-tasks", () => ({
  admitBackgroundDispatch: (...args: unknown[]) => mockAdmission(...(args as [])),
}))
jest.mock("@/lib/background-tasks/redispatch", () => ({
  captureBackgroundDispatchRecovery: jest.fn(async (input) => ({
    version: 1,
    phase: "accepted",
    namespaceId: "test",
    hostId: "host",
    contextFingerprint: "fingerprint",
    ...input,
    sideEffect: input.toolsEnabled ? "non-idempotent" : "none",
  })),
}))

const mockDispatch = dispatchSubagent as jest.MockedFunction<typeof dispatchSubagent>
afterEach(() => clearKnowledgeReaderForSession("knowledge-parent"))

it("inherits verified public knowledge authority and frozen revisions into nested dispatch", async () => {
  nesting()
  registerKnowledgeAccessForSession("knowledge-parent", {
    knowledgeBaseIds: ["kb-bound"],
    knowledgeAccess: {
      entrypoint: "http",
      triggeredBy: { source: "api", initiator: { authenticated: true, principalId: "subject-1" } },
      revisionBindings: { "kb-bound": ["gen-frozen"] },
    },
  })
  const resolved = await resolveCaller("knowledge-parent")
  expect(resolved.knowledgeAccess).toMatchObject({
    entrypoint: "http",
    allowedKnowledgeBaseIds: ["kb-bound"],
    revisionBindings: { "kb-bound": ["gen-frozen"] },
  })
  await startDispatchRun({
    subagentId: "coder",
    prompt: "read",
    toolsEnabled: true,
    background: false,
    parentSessionId: "knowledge-parent",
    caller: resolved,
  })
  expect(mockDispatch).toHaveBeenCalledWith(
    expect.anything(),
    "read",
    expect.objectContaining({ _knowledgeAccess: resolved.knowledgeAccess })
  )
})

it("gives an unknown caller an empty knowledge ceiling", async () => {
  nesting()
  expect((await resolveCaller("missing-knowledge-parent")).knowledgeAccess).toEqual({
    allowedKnowledgeBaseIds: [],
  })
})
const mockGetDef = getDispatchableSubagentDef as jest.MockedFunction<
  typeof getDispatchableSubagentDef
>
const mockGetSettings = getSettings as jest.MockedFunction<typeof getSettings>
const mockGetSession = getSession as jest.MockedFunction<typeof getSession>
const mockSessionCwd = resolveSessionCwd as jest.MockedFunction<typeof resolveSessionCwd>
const mockForegroundJournal = journalRendererForegroundRun as jest.MockedFunction<
  typeof journalRendererForegroundRun
>
const mockStartBackground = startAcceptedRendererBackgroundRun as jest.MockedFunction<
  typeof startAcceptedRendererBackgroundRun
>

const ok = (text: string): PluginSubagentDispatchResult => ({
  text,
  channel: "sidecar",
  toolsAvailable: true,
})

function nesting(over: Record<string, unknown> = {}) {
  mockGetSettings.mockResolvedValue({
    subagentNesting: { enabled: true, maxDepth: 2, tokenBudget: 0, timeoutMs: 0, ...over },
  } as never)
}

function caller(over: Partial<ResolvedCaller> = {}): ResolvedCaller {
  return {
    parentDepth: 0,
    maxDepth: 2,
    maxConcurrent: 0,
    parentChain: [],
    budgetRoot: "dispatch:test-session",
    ...over,
  }
}

const runs = () => Object.values(useSubagentRuntimeStore.getState().subAgents)

it("aborts an admitted background execution on ownership loss without cancelling the new owner", async () => {
  let dispatchedSignal: AbortSignal | undefined
  mockDispatch.mockImplementation(async (_target, _prompt, options) => {
    dispatchedSignal = options?.abortSignal
    return new Promise((resolve) =>
      options?.abortSignal?.addEventListener(
        "abort",
        () => resolve({ ...ok("cancelled"), finishReason: "cancelled" }),
        { once: true }
      )
    )
  })
  await startDispatchRun({
    subagentId: "coder",
    prompt: "work",
    parentSessionId: "chat-1",
    toolsEnabled: false,
    background: true,
    caller: caller(),
  })
  await Promise.resolve()
  const controls = mockStartBackground.mock.calls[0]?.[4]
  expect(dispatchedSignal?.aborted).toBe(false)
  controls?.onLeaseLost?.()
  expect(dispatchedSignal?.aborted).toBe(true)
  const admission = await mockAdmission.mock.results[0].value
  expect(admission.requestCancel).not.toHaveBeenCalled()
  await mockStartBackground.mock.calls[0]?.[2]
})

beforeEach(() => {
  jest.clearAllMocks()
  __clearAllDispatchContextsForTesting()
  __clearAllDispatchBudgetsForTesting()
  useSubagentRuntimeStore.getState().clearRuntime()
  mockGetDef.mockReturnValue({ id: "coder", prompt: "task" } as never)
  mockGetSession.mockResolvedValue(undefined)
  nesting()
  mockDispatch.mockResolvedValue(ok("done"))
  mockForegroundJournal.mockImplementation(async (_runId, _meta, producer) => producer)
})

describe("startDispatchRun — success + terminal records", () => {
  it("rejects late foreground success after ownership loss and keeps the terminal UI fenced", async () => {
    let resolveLate!: (value: PluginSubagentDispatchResult) => void
    let signal: AbortSignal | undefined
    mockDispatch.mockImplementation((_target, _prompt, options) => {
      signal = options?.abortSignal
      return new Promise((resolve) => {
        resolveLate = resolve
      })
    })
    mockForegroundJournal.mockImplementation(async (runId, _meta, _producer, controls) => {
      controls?.onLeaseLost?.()
      return {
        text: "Background task ownership lost",
        channel: "text",
        toolsAvailable: false,
        runId,
        finishReason: "error",
        errorEnvelope: {
          code: "interrupted",
          retryable: false,
          message: "Background task ownership lost",
        },
      }
    })
    const pending = startDispatchRun({
      subagentId: "coder",
      prompt: "work",
      toolsEnabled: false,
      background: false,
      parentSessionId: "chat-1",
      caller: caller(),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(signal?.aborted).toBe(true)
    resolveLate(ok("late success"))
    const handle = await pending
    await Promise.resolve()
    expect(handle.text).toContain("ownership lost")
    expect(handle.text).not.toContain("late success")
    expect(runs()).toEqual([expect.objectContaining({ status: "failed" })])
    expect(liveSubagentRunCount()).toBe(0)
  })

  it("runs a foreground dispatch, records completed, journals the run, and renders the outcome", async () => {
    const handle = await startDispatchRun({
      subagentId: "coder",
      prompt: "build",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-1",
      caller: caller(),
    })

    expect(handle.text).toBe("[coder]\ndone")
    expect(runs()).toEqual([expect.objectContaining({ status: "completed", name: "coder" })])
    expect(mockForegroundJournal).toHaveBeenCalledWith(
      handle.runId,
      expect.objectContaining({
        kind: "subagent",
        subagentId: "coder",
        prompt: "build",
        sessionId: "chat-1",
        host: "renderer",
        toolsEnabled: true,
      }),
      expect.any(Promise),
      expect.objectContaining({ onLeaseLost: expect.any(Function) })
    )
    expect(mockStartBackground).not.toHaveBeenCalled()
    expect(liveSubagentRunCount()).toBe(0)
  })

  it("threads resume lineage into the journal meta", async () => {
    await startDispatchRun({
      subagentId: "coder",
      prompt: "again",
      toolsEnabled: false,
      background: false,
      parentSessionId: "chat-1",
      caller: caller(),
      resumeOfRunId: "orig-1",
      resumeAttempt: 2,
    })
    expect(mockForegroundJournal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ resumeOfRunId: "orig-1", resumeAttempt: 2, toolsEnabled: false }),
      expect.any(Promise),
      expect.objectContaining({ onLeaseLost: expect.any(Function) })
    )
  })

  it("detaches a background run through the background registry and returns the runId notice", async () => {
    const handle = await startDispatchRun({
      subagentId: "coder",
      prompt: "long task",
      toolsEnabled: true,
      background: true,
      parentSessionId: "chat-1",
      caller: caller(),
    })

    expect(handle.text).toContain(`runId: ${handle.runId}`)
    expect(mockStartBackground).toHaveBeenCalledWith(
      handle.runId,
      expect.objectContaining({ subagentId: "coder", sessionId: "chat-1" }),
      expect.any(Promise),
      expect.objectContaining({ recordSettle: expect.any(Function) }),
      expect.objectContaining({ cancel: expect.any(Function) })
    )
    expect(mockForegroundJournal).not.toHaveBeenCalled()
    // The parked promise still settles the store record.
    const parked = mockStartBackground.mock.calls[0][2]
    await parked
    expect(runs()).toEqual([expect.objectContaining({ status: "completed" })])
  })
})

describe("startDispatchRun — retry loop", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("retries a transient error then succeeds (one retry recorded, single completed node)", async () => {
    nesting({ dispatchMaxRetries: 1 })
    mockDispatch
      .mockRejectedValueOnce(new Error("429 rate limit exceeded"))
      .mockResolvedValueOnce(ok("recovered"))

    const pending = startDispatchRun({
      subagentId: "coder",
      prompt: "p",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-1",
      caller: caller(),
    })
    await jest.advanceTimersByTimeAsync(10_000)
    const handle = await pending

    expect(handle.text).toBe("[coder]\nrecovered")
    expect(mockDispatch).toHaveBeenCalledTimes(2)
    expect(runs()).toEqual([
      expect.objectContaining({ status: "completed", retryCount: 1, name: "coder" }),
    ])
    expect(runs()[0].logs.some((l) => l.message.includes("Retrying after rate-limit"))).toBe(true)
  })

  it("does not retry permanent errors", async () => {
    nesting({ dispatchMaxRetries: 2 })
    mockDispatch.mockRejectedValue(new Error("401 unauthorized: invalid api key"))

    const handle = await startDispatchRun({
      subagentId: "coder",
      prompt: "p",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-1",
      caller: caller(),
    })

    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(handle.text).toBe(
      "[coder] Subagent terminated early due to 401 unauthorized: invalid api key"
    )
    expect(runs()).toEqual([
      expect.objectContaining({
        status: "failed",
        errorEnvelope: expect.objectContaining({ code: "auth", retryable: false }),
      }),
    ])
  })

  it("retries sidecar death once (the sidecar respawns) then records failed with the envelope", async () => {
    nesting({ dispatchMaxRetries: 1 })
    class FakeRunAndCaptureError extends Error {
      constructor(readonly code: string) {
        super("sidecar exited mid-run")
      }
    }
    mockDispatch.mockRejectedValue(new FakeRunAndCaptureError("sidecar_exited"))

    const pending = startDispatchRun({
      subagentId: "coder",
      prompt: "p",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-1",
      caller: caller(),
    })
    await jest.advanceTimersByTimeAsync(60_000)
    const handle = await pending

    expect(mockDispatch).toHaveBeenCalledTimes(2)
    expect(handle.text).toContain("terminated early")
    expect(runs()[0]).toMatchObject({
      status: "failed",
      errorEnvelope: expect.objectContaining({ code: "sidecar-exited" }),
      retryCount: 1,
    })
  })

  it("salvages streamed partial text into the failure envelope and cut-off note", async () => {
    nesting({ dispatchMaxRetries: 0 })
    mockDispatch.mockImplementation(async (_t, _p, opts) => {
      opts?._onEvent?.({ type: "text-delta", delta: "half the findings" })
      throw new Error("Provider overloaded_error: Overloaded")
    })

    const handle = await startDispatchRun({
      subagentId: "explore",
      prompt: "p",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-1",
      caller: caller(),
    })

    expect(handle.text).toContain("half the findings")
    expect(handle.text).toContain("cut off by an error and did not finish")
    expect(runs()[0]).toMatchObject({
      status: "failed",
      errorEnvelope: expect.objectContaining({ partialText: "half the findings" }),
      result: expect.objectContaining({ finalResponse: "half the findings" }),
    })
  })

  it("abort during backoff finalizes as cancelled", async () => {
    nesting({ dispatchMaxRetries: 3 })
    mockDispatch.mockRejectedValue(new Error("fetch failed: ECONNRESET"))

    const pending = startDispatchRun({
      subagentId: "coder",
      prompt: "p",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-1",
      caller: caller(),
    })
    // Let the first attempt fail and enter backoff, then abort mid-sleep.
    await jest.advanceTimersByTimeAsync(100)
    const running = runs().find((r) => r.status === "running")
    expect(running).toBeTruthy()
    expect(requestCancelSubagentRun(running!.id)).toBe(true)
    await jest.advanceTimersByTimeAsync(10)
    const handle = await pending

    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(handle.text).toBe("[coder] cancelled.")
    expect(runs()[0].status).toBe("cancelled")
    expect(liveSubagentRunCount()).toBe(0)
  })

  it("skips the retry when the subtree deadline cannot fit the backoff", async () => {
    nesting({ dispatchMaxRetries: 2 })
    mockDispatch.mockRejectedValue(new Error("429 rate limit"))

    const handle = await startDispatchRun({
      subagentId: "coder",
      prompt: "p",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-1",
      caller: caller({ deadlineMs: Date.now() + 50 }),
    })

    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(runs()[0].status).toBe("failed")
    expect(handle.text).toContain("terminated early")
  })

  it("skips the retry when the subtree token budget is exhausted", async () => {
    nesting({ dispatchMaxRetries: 2 })
    const guard = getOrCreateDispatchBudget("dispatch:budgeted", 100)
    guard.add({ promptTokens: 90, completionTokens: 9, totalTokens: 99 })
    mockDispatch.mockRejectedValue(new Error("429 rate limit"))

    await startDispatchRun({
      subagentId: "coder",
      prompt: "p",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-1",
      caller: caller({ budgetRoot: "dispatch:budgeted" }),
    })

    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(runs()[0].status).toBe("failed")
  })

  it("never retries guard rejections (resolved rejection results)", async () => {
    nesting({ dispatchMaxRetries: 2 })
    mockDispatch.mockResolvedValue({
      text: "Dispatch refused — cycle",
      channel: "text",
      toolsAvailable: false,
      finishReason: "rejected",
      rejection: { reason: "cycle", message: "Dispatch refused — cycle" },
      errorEnvelope: {
        code: "rejection-cycle",
        retryable: false,
        message: "Dispatch refused — cycle",
      },
    })

    const handle = await startDispatchRun({
      subagentId: "coder",
      prompt: "p",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-1",
      caller: caller(),
    })

    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(handle.text).toBe("[coder] Dispatch refused — cycle")
    expect(runs()[0].status).toBe("rejected")
  })

  it("tool-free background runs retry inside the parked promise", async () => {
    nesting({ dispatchMaxRetries: 1 })
    mockDispatch
      .mockRejectedValueOnce(new Error("429 rate limit exceeded"))
      .mockResolvedValueOnce(ok("late win"))

    await startDispatchRun({
      subagentId: "coder",
      prompt: "p",
      toolsEnabled: false,
      background: true,
      parentSessionId: "chat-1",
      caller: caller(),
    })
    const parked = mockStartBackground.mock.calls[0][2]
    await jest.advanceTimersByTimeAsync(10_000)
    const settled = await parked

    expect(settled).toMatchObject({ text: "late win" })
    expect(mockDispatch).toHaveBeenCalledTimes(2)
    expect(runs()[0]).toMatchObject({ status: "completed", retryCount: 1 })
  })
})

describe("startDispatchRun — approval route threading", () => {
  it("passes the approval route for the child's ephemeral session", async () => {
    const handle = await startDispatchRun({
      subagentId: "coder",
      prompt: "p",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-9",
      caller: caller(),
    })
    expect(mockDispatch.mock.calls[0][2]).toMatchObject({
      _approvalRoute: {
        parentSessionId: "chat-9",
        runId: handle.runId,
        subagentId: "coder",
        backgrounded: false,
      },
    })
  })
})

describe("resolveCaller / loadNesting", () => {
  it("derives the top-level caller from settings (incl. retry knob default)", async () => {
    nesting({ timeoutMs: 60_000 })
    const c = await resolveCaller("chat-1")
    expect(c).toMatchObject({ parentDepth: 0, maxDepth: 2, parentChain: [] })
    expect(c.deadlineMs).toBeGreaterThan(Date.now())
    await expect(loadNesting()).resolves.toMatchObject({ dispatchMaxRetries: 1 })
  })

  it("resolves a running subagent's registered context", async () => {
    registerDispatchContext("sub-session", {
      depth: 1,
      maxDepth: 3,
      parentChain: ["root"],
      selfRunId: "run-A",
      budgetRootRunId: "budget-root",
    })
    await expect(resolveCaller("sub-session")).resolves.toMatchObject({
      parentDepth: 1,
      maxDepth: 3,
      parentChain: ["root"],
      parentSubagentId: "run-A",
      budgetRoot: "budget-root",
    })
  })

  it("falls back to defaults when settings are unreadable", async () => {
    mockGetSettings.mockRejectedValue(new Error("no db"))
    await expect(loadNesting()).resolves.toMatchObject({
      maxDepth: 2,
      dispatchMaxRetries: 1,
    })
  })
})

describe("resolveCaller / loadNesting, concurrency cap", () => {
  it("defaults the cap to 0 (unlimited) and normalises junk values", async () => {
    nesting({})
    await expect(loadNesting()).resolves.toMatchObject({ maxConcurrent: 0 })
    nesting({ maxConcurrent: -4 })
    await expect(loadNesting()).resolves.toMatchObject({ maxConcurrent: 0 })
    nesting({ maxConcurrent: 3.7 })
    await expect(loadNesting()).resolves.toMatchObject({ maxConcurrent: 3 })
  })

  it("threads the cap to the top-level caller and to a nested caller alike", async () => {
    nesting({ maxConcurrent: 2 })
    await expect(resolveCaller("chat-cap")).resolves.toMatchObject({ maxConcurrent: 2 })
    registerDispatchContext("sub-cap", {
      depth: 1,
      maxDepth: 3,
      parentChain: ["root"],
      selfRunId: "run-B",
      budgetRootRunId: "budget-root",
    })
    await expect(resolveCaller("sub-cap")).resolves.toMatchObject({
      parentDepth: 1,
      maxConcurrent: 2,
    })
  })

  it("falls back to an unlimited cap when settings are unreadable", async () => {
    mockGetSettings.mockRejectedValue(new Error("no db"))
    await expect(loadNesting()).resolves.toMatchObject({ maxConcurrent: 0 })
  })
})

describe("startDispatchRun, per-call model override", () => {
  const caller: ResolvedCaller = {
    parentDepth: 0,
    maxDepth: 2,
    parentChain: [],
    budgetRoot: "dispatch:model",
    maxConcurrent: 0,
  }

  it("overlays the model on the resolved definition for this run only", async () => {
    mockGetDef.mockReturnValue({
      id: "coder",
      name: "coder",
      description: "d",
      prompt: "p",
      model: "base",
    })
    await startDispatchRun({
      subagentId: "coder",
      prompt: "x",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-1",
      caller,
      model: "fast",
    })
    expect(mockDispatch.mock.calls[0][0]).toMatchObject({ id: "coder", model: "fast" })
    // The registry's definition is untouched for the next run.
    expect(mockGetDef.mock.results[0].value).toMatchObject({ model: "base" })
  })

  it("cannot overlay a model on a bare SDK id, so the id passes through unchanged", async () => {
    mockGetDef.mockReturnValue(undefined)
    await startDispatchRun({
      subagentId: "sdk-only",
      prompt: "x",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-1",
      caller,
      model: "fast",
    })
    expect(mockDispatch.mock.calls[0][0]).toBe("sdk-only")
  })
})

describe("resolveCaller / cwd inheritance", () => {
  it("carries the caller session's working directory so every child inherits it", async () => {
    mockSessionCwd.mockResolvedValueOnce("/repo/parent")
    await expect(resolveCaller("chat-1")).resolves.toMatchObject({ cwd: "/repo/parent" })
    expect(mockSessionCwd).toHaveBeenCalledWith("chat-1")

    registerDispatchContext("sub-session", {
      depth: 1,
      maxDepth: 3,
      parentChain: ["root"],
      selfRunId: "run-A",
    })
    mockSessionCwd.mockResolvedValueOnce("/repo/child")
    await expect(resolveCaller("sub-session")).resolves.toMatchObject({ cwd: "/repo/child" })
  })

  it("leaves cwd absent when the session names no directory or the read fails", async () => {
    mockSessionCwd.mockResolvedValueOnce(undefined)
    expect(await resolveCaller("chat-1")).not.toHaveProperty("cwd")
    mockSessionCwd.mockRejectedValueOnce(new Error("dexie closed"))
    expect(await resolveCaller("chat-1")).not.toHaveProperty("cwd")
  })

  it("hands the caller's cwd to the dispatched child", async () => {
    await startDispatchRun({
      subagentId: "coder",
      prompt: "build",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-1",
      caller: caller({ cwd: "/repo/parent" }),
    })
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "coder" }),
      "build",
      expect.objectContaining({ cwd: "/repo/parent" })
    )
    mockDispatch.mockClear()
    await startDispatchRun({
      subagentId: "coder",
      prompt: "build",
      toolsEnabled: true,
      background: false,
      parentSessionId: "chat-1",
      caller: caller(),
    })
    expect(mockDispatch.mock.calls[0][2]).not.toHaveProperty("cwd")
  })
})

describe("durable background admission", () => {
  it("never dispatches or reports started if admission persistence fails", async () => {
    mockAdmission.mockRejectedValueOnce(new Error("journal unavailable"))
    const result = await startDispatchRun({
      subagentId: "coder",
      prompt: "p",
      toolsEnabled: true,
      background: true,
      parentSessionId: "chat-1",
      caller: caller(),
    })
    expect(result.error).toBe("journal unavailable")
    expect(mockDispatch).not.toHaveBeenCalled()
    expect(mockStartBackground).not.toHaveBeenCalled()
    expect(liveSubagentRunCount()).toBe(0)
  })

  it("waits for the durable dispatch marker before starting the runtime", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mockAdmission.mockResolvedValueOnce({
      journal: { recordStart: jest.fn(), recordSettle: jest.fn() },
      markDispatched: jest.fn(() => gate),
      requestCancel: jest.fn(async (): Promise<void> => undefined),
    })
    const result = await startDispatchRun({
      subagentId: "coder",
      prompt: "p",
      toolsEnabled: false,
      background: true,
      parentSessionId: "chat-1",
      caller: caller(),
    })
    expect(result.error).toBeUndefined()
    expect(mockDispatch).not.toHaveBeenCalled()
    release()
    await mockStartBackground.mock.calls[0][2]
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.any(Object),
      "p",
      expect.objectContaining({ _sessionId: `background:${result.runId}` })
    )
  })
})

it("does not retry a background tool-capable attempt after an ambiguous transport failure", async () => {
  nesting({ dispatchMaxRetries: 2 })
  mockDispatch.mockRejectedValueOnce(new Error("429 rate limit exceeded"))
  await startDispatchRun({
    subagentId: "coder",
    prompt: "mutate",
    toolsEnabled: true,
    background: true,
    parentSessionId: "chat-1",
    caller: caller(),
  })
  await mockStartBackground.mock.calls[0][2]
  expect(mockDispatch).toHaveBeenCalledTimes(1)
  expect(runs()[0].status).toBe("failed")
})
