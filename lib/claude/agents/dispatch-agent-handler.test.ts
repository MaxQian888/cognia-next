import {
  runDispatchAgentTool,
  releaseDispatchBudgetForSession,
  releaseDispatchStateForSession,
} from "./dispatch-agent-handler"
import { dispatchSubagent } from "@/lib/plugin/agent-sdk/dispatch"
import { getDispatchableSubagentDef } from "@/lib/claude/agents/subagents"
import { getSettings } from "@/lib/db/settings"
import { getSession } from "@/lib/db/sessions"
import {
  registerDispatchContext,
  recordResolvedPermissionCeiling,
  getResolvedPermissionCeiling,
  __clearAllDispatchContextsForTesting,
} from "./dispatch-context-registry"
import {
  __clearAllDispatchBudgetsForTesting,
  getOrCreateDispatchBudget,
  getDispatchBudget,
} from "./dispatch-budget"
import {
  __clearRendererBackgroundRunsForTesting,
  cancelRendererBackgroundRun,
} from "@/lib/background-tasks/renderer-subagent-registry"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { requestCancelSubagentRun, liveSubagentRunCount } from "./subagent-cancel-registry"
import type { PluginSubagentDispatchResult } from "@/types/plugin/plugin-agent-sdk"

/** Spin the event loop until `pred()` is truthy or attempts run out. */
async function waitFor<T>(pred: () => T | undefined, attempts = 100): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const v = pred()
    if (v) return v
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error("waitFor: condition never met")
}

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

const mockDispatch = dispatchSubagent as jest.MockedFunction<typeof dispatchSubagent>
const mockGetDef = getDispatchableSubagentDef as jest.MockedFunction<
  typeof getDispatchableSubagentDef
>
const mockGetSettings = getSettings as jest.MockedFunction<typeof getSettings>
const mockGetSession = getSession as jest.MockedFunction<typeof getSession>

const ok = (text: string, runId = "child-1"): PluginSubagentDispatchResult => ({
  text,
  channel: "sidecar",
  toolsAvailable: true,
  runId,
})

beforeEach(() => {
  jest.clearAllMocks()
  __clearAllDispatchContextsForTesting()
  __clearAllDispatchBudgetsForTesting()
  __clearRendererBackgroundRunsForTesting()
  useSubagentRuntimeStore.getState().clearRuntime()
  mockGetDef.mockReturnValue(undefined)
  mockGetSettings.mockResolvedValue({
    subagentNesting: { enabled: true, maxDepth: 2, tokenBudget: 0, timeoutMs: 0 },
  } as never)
  mockGetSession.mockResolvedValue(undefined)
  mockDispatch.mockResolvedValue(ok("done"))
})

describe("runDispatchAgentTool — call modes", () => {
  it("errors on unusable args", async () => {
    const out = await runDispatchAgentTool({ sessionId: "s", args: {} })
    expect(out).toMatch(/provide/i)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("dispatches a single subagent at top level (depth 0, empty chain)", async () => {
    const out = await runDispatchAgentTool({
      sessionId: "chat-1",
      args: { subagentId: "coder", prompt: "build" },
    })
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    const [target, prompt, opts] = mockDispatch.mock.calls[0]
    expect(target).toBe("coder") // no inline def → raw id
    expect(prompt).toBe("build")
    expect(opts).toMatchObject({ _depth: 0, _maxDepth: 2, _parentChain: [] })
    // Live-progress sink is wired so the subagent card updates mid-run.
    expect(typeof (opts as { _onEvent?: unknown })._onEvent).toBe("function")
    expect(out).toContain("done")
  })

  it("threads the caller's registered nesting context (depth + parent chain + edge)", async () => {
    registerDispatchContext("sub-session", {
      depth: 1,
      maxDepth: 3,
      parentChain: ["root-agent"],
      selfRunId: "run-A",
      budgetRootRunId: "budget-root",
    })
    await runDispatchAgentTool({
      sessionId: "sub-session",
      args: { subagentId: "coder", prompt: "x" },
    })
    expect(mockDispatch.mock.calls[0][2]).toMatchObject({
      _depth: 1,
      _maxDepth: 3,
      _parentChain: ["root-agent"],
      _budgetRootRunId: "budget-root",
    })
    // The store run links to the caller's run id as its tree edge.
    const runs = Object.values(useSubagentRuntimeStore.getState().subAgents)
    expect(runs.some((r) => r.parentSubagentId === "run-A" && r.depth === 2)).toBe(true)
  })

  it("threads the top-level caller's resolved permission ceiling to the child", async () => {
    // The chat session resolved to a Read-only ceiling this turn.
    recordResolvedPermissionCeiling("chat-1", { allowedTools: ["Read"], permissionMode: "plan" })
    await runDispatchAgentTool({
      sessionId: "chat-1",
      args: { subagentId: "coder", prompt: "build" },
    })
    expect(mockDispatch.mock.calls[0][2]).toMatchObject({
      _permissionCeiling: { allowedTools: ["Read"], permissionMode: "plan" },
    })
  })

  it("threads a running subagent caller's resolved ceiling (depth ≥ 1)", async () => {
    registerDispatchContext("sub-session", {
      depth: 1,
      maxDepth: 3,
      parentChain: ["root-agent"],
    })
    recordResolvedPermissionCeiling("sub-session", { allowedTools: ["Read", "Grep"] })
    await runDispatchAgentTool({
      sessionId: "sub-session",
      args: { subagentId: "coder", prompt: "x" },
    })
    expect(mockDispatch.mock.calls[0][2]).toMatchObject({
      _depth: 1,
      _permissionCeiling: { allowedTools: ["Read", "Grep"] },
    })
  })

  it("omits the ceiling when the caller recorded none (no restriction)", async () => {
    await runDispatchAgentTool({
      sessionId: "chat-1",
      args: { subagentId: "coder", prompt: "build" },
    })
    expect(mockDispatch.mock.calls[0][2]).not.toHaveProperty("_permissionCeiling")
  })

  it("falls back to the session row's permissionMode when no ceiling was recorded", async () => {
    // Belt-and-braces: the parent send never ran resolveSendOptions' ceiling
    // recorder (early return / missing session.id), but the session row itself
    // says plan — the child must still inherit the plan clamp.
    mockGetSession.mockResolvedValue({ id: "chat-1", permissionMode: "plan" } as never)
    await runDispatchAgentTool({
      sessionId: "chat-1",
      args: { subagentId: "coder", prompt: "build" },
    })
    expect(mockDispatch.mock.calls[0][2]).toMatchObject({
      _permissionCeiling: { permissionMode: "plan" },
    })
  })

  it("a recorded ceiling wins over a divergent session-row mode", async () => {
    recordResolvedPermissionCeiling("chat-1", { permissionMode: "acceptEdits" })
    mockGetSession.mockResolvedValue({ id: "chat-1", permissionMode: "plan" } as never)
    await runDispatchAgentTool({
      sessionId: "chat-1",
      args: { subagentId: "coder", prompt: "build" },
    })
    // The recorded ceiling is post-clamp and authoritative — never overridden.
    expect(mockDispatch.mock.calls[0][2]).toMatchObject({
      _permissionCeiling: { permissionMode: "acceptEdits" },
    })
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it("does not synthesize a ceiling from an `auto` session mode (no ACP equivalent)", async () => {
    mockGetSession.mockResolvedValue({ id: "chat-1", permissionMode: "auto" } as never)
    await runDispatchAgentTool({
      sessionId: "chat-1",
      args: { subagentId: "coder", prompt: "build" },
    })
    expect(mockDispatch.mock.calls[0][2]).not.toHaveProperty("_permissionCeiling")
  })

  it("uses the resolved inline def when available (projected ids)", async () => {
    mockGetDef.mockReturnValue({
      id: "template:x",
      name: "X",
      description: "d",
      prompt: "p",
      allowNesting: true,
    })
    await runDispatchAgentTool({
      sessionId: "chat-1",
      args: { subagentId: "template:x", prompt: "go" },
    })
    expect(mockDispatch.mock.calls[0][0]).toMatchObject({ id: "template:x", allowNesting: true })
  })

  it("fans out in parallel and joins results", async () => {
    mockDispatch.mockImplementation(async (_id, prompt) => ok(`R:${prompt}`))
    const out = await runDispatchAgentTool({
      sessionId: "chat-1",
      args: {
        dispatches: [
          { subagentId: "a", prompt: "one" },
          { subagentId: "b", prompt: "two" },
        ],
      },
    })
    expect(mockDispatch).toHaveBeenCalledTimes(2)
    expect(out).toContain("R:one")
    expect(out).toContain("R:two")
    expect(out).toContain("---")
  })

  it("backgrounds a run and returns a runId, collectable later", async () => {
    let resolveDispatch!: (r: PluginSubagentDispatchResult) => void
    mockDispatch.mockReturnValue(
      new Promise<PluginSubagentDispatchResult>((res) => {
        resolveDispatch = res
      })
    )
    const started = await runDispatchAgentTool({
      sessionId: "chat-1",
      args: { subagentId: "coder", prompt: "long", background: true },
    })
    expect(started).toMatch(/background/i)
    const runIdMatch = started.match(/runId: ([\w-]+)/)
    expect(runIdMatch).toBeTruthy()
    const runId = runIdMatch![1]

    resolveDispatch(ok("late result", runId))
    const collected = await runDispatchAgentTool({
      sessionId: "chat-1",
      args: { collect: runId },
    })
    expect(collected).toContain("late result")
  })

  it("threads a cancellable abort signal into background dispatches", async () => {
    mockDispatch.mockReturnValue(new Promise<PluginSubagentDispatchResult>(() => {}))
    const started = await runDispatchAgentTool({
      sessionId: "chat-1",
      args: { subagentId: "coder", prompt: "long", background: true },
    })
    const runId = started.match(/runId: ([\w-]+)/)?.[1]
    expect(runId).toBeTruthy()
    const signal = mockDispatch.mock.calls[0][2]?.abortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)

    expect(cancelRendererBackgroundRun(runId!)).toBe(true)
    expect(signal?.aborted).toBe(true)
  })

  it("registers every foreground run in the cancel registry and aborting marks it cancelled", async () => {
    // Dispatch hangs until its abort signal fires, then rejects — mirroring a
    // user-cancelled run.
    mockDispatch.mockImplementation(
      (_id, _prompt, opts) =>
        new Promise<PluginSubagentDispatchResult>((_res, rej) => {
          const signal = (opts as { abortSignal?: AbortSignal }).abortSignal
          signal?.addEventListener("abort", () => rej(new Error("aborted by user")))
        })
    )
    const pending = runDispatchAgentTool({
      sessionId: "chat-1",
      args: { subagentId: "coder", prompt: "long" },
    })

    // The foreground run is registered (Abort button can reach it) and running.
    // (liveSubagentRunCount is process-global; assert the delta, not an absolute.)
    const running = await waitFor(() =>
      Object.values(useSubagentRuntimeStore.getState().subAgents).find(
        (r) => r.status === "running"
      )
    )
    const liveBefore = liveSubagentRunCount()
    expect(liveBefore).toBeGreaterThanOrEqual(1)

    expect(requestCancelSubagentRun(running.id)).toBe(true)
    const out = await pending
    // Cancellation renders as a terse model-facing note (v2.1.199 semantics),
    // not the raw abort error text.
    expect(out).toMatch(/\[coder\] cancelled\./)

    // Aborted → cancelled, NOT failed; and the registry entry is cleaned up.
    const runs = Object.values(useSubagentRuntimeStore.getState().subAgents)
    expect(runs.some((r) => r.status === "cancelled")).toBe(true)
    expect(runs.some((r) => r.status === "failed")).toBe(false)
    expect(liveSubagentRunCount()).toBe(liveBefore - 1)
  })

  it("returns a clear message when collecting an unknown run", async () => {
    const out = await runDispatchAgentTool({ sessionId: "chat-1", args: { collect: "ghost" } })
    expect(out).toMatch(/no background run/i)
  })

  it("surfaces a rejection result and records it as rejected", async () => {
    mockDispatch.mockResolvedValue({
      text: "Dispatch refused — max nesting depth (2) reached.",
      channel: "text",
      toolsAvailable: false,
      runId: "child-1",
      rejection: {
        reason: "max-depth",
        message: "Dispatch refused — max nesting depth (2) reached.",
      },
      depthExhausted: true,
    })
    const out = await runDispatchAgentTool({
      sessionId: "chat-1",
      args: { subagentId: "coder", prompt: "deep" },
    })
    expect(out).toMatch(/max nesting depth/i)
    const runs = Object.values(useSubagentRuntimeStore.getState().subAgents)
    expect(runs.some((r) => r.status === "rejected")).toBe(true)
  })

  it("records a thrown dispatch as failed and surfaces the error", async () => {
    mockDispatch.mockRejectedValue(new Error("kaboom"))
    const out = await runDispatchAgentTool({
      sessionId: "chat-1",
      args: { subagentId: "coder", prompt: "x" },
    })
    expect(out).toContain("kaboom")
    const runs = Object.values(useSubagentRuntimeStore.getState().subAgents)
    expect(runs.some((r) => r.status === "failed")).toBe(true)
  })

  it("releaseDispatchBudgetForSession drops the session's leaked guard", () => {
    getOrCreateDispatchBudget("dispatch:chat-xyz", 1000)
    expect(getDispatchBudget("dispatch:chat-xyz")).toBeDefined()
    releaseDispatchBudgetForSession("chat-xyz")
    expect(getDispatchBudget("dispatch:chat-xyz")).toBeUndefined()
  })

  it("releaseDispatchStateForSession drops the budget guard AND the resolved ceiling", () => {
    getOrCreateDispatchBudget("dispatch:chat-xyz", 1000)
    recordResolvedPermissionCeiling("chat-xyz", { allowedTools: ["Read"] })
    expect(getDispatchBudget("dispatch:chat-xyz")).toBeDefined()
    expect(getResolvedPermissionCeiling("chat-xyz")).toBeDefined()
    releaseDispatchStateForSession("chat-xyz")
    expect(getDispatchBudget("dispatch:chat-xyz")).toBeUndefined()
    expect(getResolvedPermissionCeiling("chat-xyz")).toBeUndefined()
  })
})

describe("runDispatchAgentTool — fan-out concurrency vs budget", () => {
  // Track peak concurrent dispatches so we can distinguish serialized from
  // parallel fan-out without depending on wall-clock timing.
  const trackingDispatch = () => {
    let active = 0
    let peak = 0
    mockDispatch.mockImplementation(async (_id, prompt) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 0))
      active -= 1
      return ok(`R:${prompt}`)
    })
    return () => peak
  }

  const twoDispatches = {
    dispatches: [
      { subagentId: "a", prompt: "one" },
      { subagentId: "b", prompt: "two" },
    ],
  }

  it("serializes parallel fan-out under a FINITE budget (peak concurrency 1)", async () => {
    mockGetSettings.mockResolvedValue({
      subagentNesting: { enabled: true, maxDepth: 2, tokenBudget: 100, timeoutMs: 0 },
    } as never)
    const peak = trackingDispatch()
    const out = await runDispatchAgentTool({ sessionId: "chat-finite", args: twoDispatches })
    expect(peak()).toBe(1)
    expect(out).toContain("R:one")
    expect(out).toContain("R:two")
  })

  it("keeps parallel fan-out under an UNLIMITED budget (peak concurrency 2)", async () => {
    // Default beforeEach settings carry tokenBudget: 0 (unlimited).
    const peak = trackingDispatch()
    await runDispatchAgentTool({ sessionId: "chat-unlimited", args: twoDispatches })
    expect(peak()).toBe(2)
  })
})
