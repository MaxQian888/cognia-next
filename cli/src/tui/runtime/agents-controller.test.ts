/**
 * @jest-environment node
 */
jest.mock("../../agent/subagent-background-tasks", () => ({
  listCliBackgroundRuns: jest.fn(() => []),
}))
jest.mock("@/lib/db/background-tasks", () => ({
  listBackgroundTaskRecords: jest.fn(async () => []),
}))
const discoverDispatchableAgents = jest.fn(async (..._args: unknown[]) => [] as unknown[])
jest.mock("../../agent/discover-agents", () => ({
  discoverDispatchableAgents: (...args: unknown[]) => discoverDispatchableAgents(...args),
  // Passthrough: with no per-subagent overrides the real impl returns its input.
  applySubagentModelOverrides: (agents: unknown[]) => agents,
}))
jest.mock("../../agent/builtin-agents", () => ({
  withBuiltinAgents: (agents: unknown[]) => agents,
}))

import { agentsDispatch, agentsList, agentsModelsPanel, agentsPanel } from "./agents-controller"
import type { AgentSummary } from "../../agent/discover-agents"
import type { ResolvedConfig } from "../../config/schema"
import type { CliBackgroundRunInfo } from "../../agent/subagent-background-tasks"
import type { BackgroundTaskJournalRecord } from "@/lib/background-tasks/registry-core"
import type { TuiAction } from "../state/types"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const agent = (id: string, description = ""): AgentSummary => ({
  id,
  name: id,
  description,
  def: { id, name: id, description, prompt: "p" },
})

describe("agentsList", () => {
  it("notices the discovered subagents with a usage hint", async () => {
    const { dispatch, actions } = recorder()
    await agentsList({
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer", "reviews code"), agent("planner")],
    })
    const msg = (actions[0] as { message: string }).message
    expect(msg).toContain("reviewer")
    expect(msg).toContain("reviews code")
    expect(msg).toContain("/agents run")
  })

  it("notices when none are found", async () => {
    const { dispatch, actions } = recorder()
    await agentsList({ dispatch, cwd: "/w", list: async () => [] })
    expect((actions[0] as { message: string }).message).toContain("No subagents")
  })

  it("discovers agents from the roots when no list is injected", async () => {
    const { dispatch, actions } = recorder()
    discoverDispatchableAgents.mockResolvedValueOnce([])
    await agentsList({ dispatch, cwd: "/w" })
    expect(discoverDispatchableAgents).toHaveBeenCalledWith(["/w"])
    expect((actions[0] as { message: string }).message).toContain("No subagents")
  })
})

const cfg = (over: Partial<ResolvedConfig> = {}): ResolvedConfig =>
  ({
    provider: "anthropic",
    permissionMode: "default",
    builtinTools: {},
    providers: { anthropic: {} },
    cwd: "/w",
    ...over,
  }) as ResolvedConfig

describe("agentsModelsPanel", () => {
  it("opens the subagentModels overlay with rows built from raw agents + config", async () => {
    const { dispatch, actions } = recorder()
    await agentsModelsPanel({
      dispatch,
      cwd: "/w",
      config: cfg({ subagentModels: { reviewer: { model: "x" } } }),
      list: async () => [agent("reviewer", "reviews code"), agent("planner")],
    })
    const overlay = (
      actions[0] as {
        overlay: { kind: string; rows: { id: string; source: string }[]; index: number }
      }
    ).overlay
    expect(overlay.kind).toBe("subagentModels")
    expect(overlay.index).toBe(0)
    expect(overlay.rows.map((r) => r.id)).toEqual(["planner", "reviewer"]) // sorted by name
    expect(overlay.rows.find((r) => r.id === "reviewer")?.source).toBe("override")
    expect(overlay.rows.find((r) => r.id === "planner")?.source).toBe("inherit")
  })

  it("discovers agents from the roots when no list is injected", async () => {
    const { dispatch, actions } = recorder()
    discoverDispatchableAgents.mockResolvedValueOnce([])
    await agentsModelsPanel({ dispatch, cwd: "/w", config: cfg() })
    expect(discoverDispatchableAgents).toHaveBeenCalledWith(["/w"])
    // withBuiltinAgents is mocked to passthrough here, so an empty discovery
    // yields an empty (but still well-formed) overlay.
    const overlay = (actions[0] as { overlay: { kind: string; rows: unknown[] } }).overlay
    expect(overlay.kind).toBe("subagentModels")
    expect(overlay.rows).toEqual([])
  })
})

describe("agentsPanel", () => {
  const liveRun = (over: Partial<CliBackgroundRunInfo>): CliBackgroundRunInfo => ({
    runId: "r1",
    subagentId: "reviewer",
    status: "running",
    startedAt: 1_000,
    sessionId: "s",
    ...over,
  })
  const record = (over: Partial<BackgroundTaskJournalRecord>): BackgroundTaskJournalRecord => ({
    runId: "r1",
    kind: "subagent",
    subagentId: "reviewer",
    prompt: "review",
    sessionId: "s",
    host: "cli",
    status: "running",
    startedAt: 1_000,
    ...over,
  })

  it("opens the agents overlay with merged in-turn + background rows", async () => {
    const { dispatch, actions } = recorder()
    await agentsPanel({
      dispatch,
      inflight: [{ callKey: "k1", name: "scout", task: "search" }],
      liveRuns: () => [liveRun({ runId: "r1" })],
      journal: async () => [record({ runId: "r1" }), record({ runId: "old", status: "done" })],
    })
    expect(actions).toHaveLength(1)
    const overlay = (actions[0] as { overlay: { kind: string; rows: { id: string }[] } }).overlay
    expect(overlay.kind).toBe("agents")
    expect(overlay.rows.map((r) => r.id)).toEqual(["inflight:k1", "bg:r1", "bg:old"])
  })

  it("threads injected live-output entries into the panel rows", async () => {
    const { dispatch, actions } = recorder()
    await agentsPanel({
      dispatch,
      inflight: [],
      liveSubagents: () => [
        {
          liveId: "live-3",
          name: "scout",
          task: "search",
          sessionId: "s",
          status: "running",
          startedAt: 1_000,
          text: "partial",
          thinking: "",
          tools: [],
          timeline: [],
          toolUseCount: 0,
          approxChars: 0,
          version: 1,
        },
      ],
      liveRuns: () => [],
      journal: async () => [],
    })
    const overlay = (actions[0] as { overlay: { rows: { id: string; liveId?: string }[] } }).overlay
    expect(overlay.rows).toEqual([expect.objectContaining({ id: "live:live-3", liveId: "live-3" })])
  })

  it("scopes the journal records to the panel's session id", async () => {
    const { dispatch, actions } = recorder()
    await agentsPanel({
      dispatch,
      inflight: [],
      sessionId: "mine",
      liveRuns: () => [],
      journal: async () => [
        record({ runId: "mine-1", sessionId: "mine", status: "done" }),
        record({ runId: "other-1", sessionId: "other", status: "done" }),
      ],
    })
    const overlay = (actions[0] as { overlay: { rows: { id: string }[] } }).overlay
    // Only the current session's run survives the cross-session filter.
    expect(overlay.rows.map((r) => r.id)).toEqual(["bg:mine-1"])
  })

  it("passes the session id to the default live-run source", async () => {
    const { listCliBackgroundRuns } = jest.requireMock("../../agent/subagent-background-tasks") as {
      listCliBackgroundRuns: jest.Mock
    }
    listCliBackgroundRuns.mockClear()
    const { dispatch } = recorder()
    await agentsPanel({ dispatch, inflight: [], sessionId: "mine" })
    expect(listCliBackgroundRuns).toHaveBeenCalledWith("mine")
  })

  it("opens an empty overlay when nothing is running or recorded", async () => {
    const { dispatch, actions } = recorder()
    await agentsPanel({ dispatch, inflight: [], liveRuns: () => [], journal: async () => [] })
    const overlay = (actions[0] as { overlay: { kind: string; rows: unknown[] } }).overlay
    expect(overlay.kind).toBe("agents")
    expect(overlay.rows).toEqual([])
  })

  it("falls back to the live registry + journal when sources are not injected", async () => {
    const { dispatch, actions } = recorder()
    await agentsPanel({ dispatch, inflight: [] })
    // The mocked default sources return empty → an empty agents overlay.
    const overlay = (actions[0] as { overlay: { kind: string; rows: unknown[] } }).overlay
    expect(overlay.kind).toBe("agents")
    expect(overlay.rows).toEqual([])
  })
})

describe("agentsDispatch", () => {
  it("dispatches the named subagent and surfaces its reply", async () => {
    const { dispatch, actions } = recorder()
    let received: { id: string; prompt: string } | null = null
    await agentsDispatch("reviewer check the diff", {
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer")],
      dispatchAgent: async (def, prompt) => {
        received = { id: def.id, prompt }
        return { text: "looks good" }
      },
    })
    expect(received).toEqual({ id: "reviewer", prompt: "check the diff" })
    expect(actions[0]).toMatchObject({ type: "ACTIVITY_START", kind: "agent" })
    expect((actions.at(-1) as { summary: string }).summary).toContain("looks good")
  })

  it("enriches the summary with token spend and a non-default finish reason", async () => {
    const { dispatch, actions } = recorder()
    await agentsDispatch("reviewer go", {
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer")],
      dispatchAgent: async () => ({
        text: "done",
        usage: { totalTokens: 1234 },
        finishReason: "max_tokens",
      }),
    })
    const summary = (actions.at(-1) as { summary: string }).summary
    expect(summary).toContain("1234 tok")
    expect(summary).toContain("max_tokens")
    expect(summary).toContain("done")
  })

  it("ends with an error when a nesting guard refuses the dispatch", async () => {
    const { dispatch, actions } = recorder()
    await agentsDispatch("reviewer go", {
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer")],
      dispatchAgent: async () => ({
        text: "",
        rejection: { reason: "max-depth", message: "depth cap reached" },
      }),
    })
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "error" })
    expect((actions.at(-1) as { summary: string }).summary).toContain("max-depth")
    expect((actions.at(-1) as { summary: string }).summary).toContain("depth cap reached")
  })

  it("notices usage when no prompt is supplied", async () => {
    const { dispatch, actions } = recorder()
    await agentsDispatch("reviewer", {
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer")],
    })
    expect((actions[0] as { message: string }).message).toContain("/agents run")
  })

  it("notices an unknown subagent id", async () => {
    const { dispatch, actions } = recorder()
    await agentsDispatch("ghost do something", {
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer")],
    })
    expect((actions[0] as { message: string }).message).toContain("ghost")
  })

  it("ends with an error when dispatch throws", async () => {
    const { dispatch, actions } = recorder()
    await agentsDispatch("reviewer go", {
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer")],
      dispatchAgent: async () => {
        throw new Error("nope")
      },
    })
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "error" })
  })
})
