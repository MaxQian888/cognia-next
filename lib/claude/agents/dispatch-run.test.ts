import { startDispatchRun, resolveCaller, loadNesting, type ResolvedCaller } from "./dispatch-run"
import { dispatchSubagent } from "@/lib/plugin/agent-sdk/dispatch"
import { getDispatchableSubagentDef } from "@/lib/claude/agents/subagents"
import { getSettings } from "@/lib/db/settings"
import { getSession } from "@/lib/db/sessions"
import {
  journalRendererForegroundRun,
  startRendererBackgroundRun,
} from "@/lib/background-tasks/renderer-subagent-registry"
import {
  registerDispatchContext,
  __clearAllDispatchContextsForTesting,
} from "./dispatch-context-registry"
import { __clearAllDispatchBudgetsForTesting, getOrCreateDispatchBudget } from "./dispatch-budget"
import { requestCancelSubagentRun, liveSubagentRunCount } from "./subagent-cancel-registry"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { PluginSubagentDispatchResult } from "@/types/plugin/plugin-agent-sdk"

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
jest.mock("@/lib/background-tasks/renderer-subagent-registry", () => ({
  __esModule: true,
  journalRendererForegroundRun: jest.fn(),
  startRendererBackgroundRun: jest.fn(),
}))

const mockDispatch = dispatchSubagent as jest.MockedFunction<typeof dispatchSubagent>
const mockGetDef = getDispatchableSubagentDef as jest.MockedFunction<
  typeof getDispatchableSubagentDef
>
const mockGetSettings = getSettings as jest.MockedFunction<typeof getSettings>
const mockGetSession = getSession as jest.MockedFunction<typeof getSession>
const mockForegroundJournal = journalRendererForegroundRun as jest.MockedFunction<
  typeof journalRendererForegroundRun
>
const mockStartBackground = startRendererBackgroundRun as jest.MockedFunction<
  typeof startRendererBackgroundRun
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
    parentChain: [],
    budgetRoot: "dispatch:test-session",
    ...over,
  }
}

const runs = () => Object.values(useSubagentRuntimeStore.getState().subAgents)

beforeEach(() => {
  jest.clearAllMocks()
  __clearAllDispatchContextsForTesting()
  __clearAllDispatchBudgetsForTesting()
  useSubagentRuntimeStore.getState().clearRuntime()
  mockGetDef.mockReturnValue(undefined)
  mockGetSession.mockResolvedValue(undefined)
  nesting()
  mockDispatch.mockResolvedValue(ok("done"))
})

describe("startDispatchRun — success + terminal records", () => {
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
      expect.any(Promise)
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
      expect.any(Promise)
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

  it("background runs retry inside the parked promise", async () => {
    nesting({ dispatchMaxRetries: 1 })
    mockDispatch
      .mockRejectedValueOnce(new Error("429 rate limit exceeded"))
      .mockResolvedValueOnce(ok("late win"))

    await startDispatchRun({
      subagentId: "coder",
      prompt: "p",
      toolsEnabled: true,
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
