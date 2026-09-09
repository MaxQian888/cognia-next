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

import {
  agentFilePath,
  agentsDispatch,
  agentsEditEffect,
  agentsList,
  agentsModelsPanel,
  agentsNew,
  agentsPanel,
  agentsRemove,
  agentsStop,
  parseAgentsRunArgs,
  renderStarterAgentFile,
  type AgentAuthoringFs,
} from "./agents-controller"
import { parseMarkdownAgent } from "@/lib/claude/agents/markdown-agents"
import {
  __clearLiveSubagentsForTesting,
  getLiveSubagent,
  listLiveSubagents,
} from "../../agent/subagent-live-output"
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

describe("agents cancellation boundaries", () => {
  it("does not discover or dispatch with an already aborted signal", async () => {
    const { dispatch, actions } = recorder()
    const list = jest.fn()
    const dispatchAgent = jest.fn()
    await agentsDispatch("reviewer work", {
      dispatch,
      cwd: "/w",
      signal: AbortSignal.abort(),
      list,
      dispatchAgent,
    })
    expect(list).not.toHaveBeenCalled()
    expect(dispatchAgent).not.toHaveBeenCalled()
    expect(actions).toEqual([])
  })

  it("does not dispatch after cancellation during discovery", async () => {
    const { dispatch, actions } = recorder()
    const controller = new AbortController()
    const dispatchAgent = jest.fn()
    await agentsDispatch("reviewer work", {
      dispatch,
      cwd: "/w",
      signal: controller.signal,
      list: async () => {
        controller.abort()
        return [agent("reviewer")]
      },
      dispatchAgent,
    })
    expect(dispatchAgent).not.toHaveBeenCalled()
    expect(actions).toEqual([])
  })

  it("reports discovery failures without an unhandled rejection or a started activity", async () => {
    const { dispatch, actions } = recorder()
    await agentsDispatch("reviewer work", {
      dispatch,
      cwd: "/w",
      list: async () => {
        throw new Error("discovery failed")
      },
    })
    expect(actions).toEqual([
      { type: "NOTICE", message: "Subagent discovery failed: discovery failed" },
    ])
  })

  it("suppresses late models and agents overlays after cancellation", async () => {
    const { dispatch, actions } = recorder()
    const models = new AbortController()
    await agentsModelsPanel({
      dispatch,
      cwd: "/w",
      config: {} as ResolvedConfig,
      signal: models.signal,
      list: async () => {
        models.abort()
        return [agent("reviewer")]
      },
    })
    const panel = new AbortController()
    await agentsPanel({
      dispatch,
      inflight: [],
      signal: panel.signal,
      liveSubagents: () => [],
      liveRuns: () => [],
      journal: async () => {
        panel.abort()
        return []
      },
    })
    expect(actions).toEqual([])
  })

  it("does not report a late successful result as done after abort", async () => {
    const { dispatch, actions } = recorder()
    const controller = new AbortController()
    await agentsDispatch("reviewer work", {
      dispatch,
      cwd: "/w",
      signal: controller.signal,
      list: async () => [agent("reviewer")],
      dispatchAgent: async () => {
        controller.abort()
        return { text: "late success" }
      },
    })
    expect(actions.at(-1)).toMatchObject({
      type: "ACTIVITY_END",
      status: "done",
      summary: 'Subagent "reviewer" interrupted.',
    })
    expect(JSON.stringify(actions)).not.toContain("late success")
  })

  it("validates stop ids and passes the owning session to cancellation", () => {
    const { dispatch, actions } = recorder()
    const cancel = jest.fn(() => true)
    agentsStop(" ", { dispatch, sessionId: "s1", cancel })
    expect(cancel).not.toHaveBeenCalled()
    agentsStop(" bg-1 ", { dispatch, sessionId: "s1", cancel })
    expect(cancel).toHaveBeenCalledWith("bg-1", "s1")
    expect(actions.at(-1)).toMatchObject({
      message: "Cancellation requested for background run bg-1.",
    })
    cancel.mockReturnValueOnce(false)
    agentsStop("unknown", { dispatch, sessionId: "s1", cancel })
    expect(actions.at(-1)).toMatchObject({
      message: expect.stringContaining("No cancellable background run"),
    })
  })
})

afterEach(() => {
  __clearLiveSubagentsForTesting()
})

describe("parseAgentsRunArgs", () => {
  it("splits the id from the prompt and reads the --bg flag in either spelling", () => {
    expect(parseAgentsRunArgs("reviewer check it")).toEqual({
      background: false,
      id: "reviewer",
      prompt: "check it",
    })
    expect(parseAgentsRunArgs("--bg reviewer check it")).toEqual({
      background: true,
      id: "reviewer",
      prompt: "check it",
    })
    expect(parseAgentsRunArgs("  --background   reviewer  go ")).toMatchObject({
      background: true,
      id: "reviewer",
      prompt: "go",
    })
    expect(parseAgentsRunArgs("--bg")).toEqual({ background: true, id: "", prompt: "" })
  })
})

describe("agentsDispatch, live panel and background", () => {
  it("streams a manual run into a live entry that settles done, tinted by the agent colour", async () => {
    const { dispatch } = recorder()
    const coloured: AgentSummary = {
      ...agent("scout"),
      def: { ...agent("scout").def, color: "cyan" },
    }
    let liveDuringRun: ReturnType<typeof listLiveSubagents> = []
    await agentsDispatch("scout look around", {
      dispatch,
      cwd: "/w",
      sessionId: "s1",
      list: async () => [coloured],
      dispatchAgent: async (_def, _prompt, opts) => {
        liveDuringRun = listLiveSubagents("s1")
        opts.onEvent?.({ type: "text-delta", delta: "hello" } as never)
        return { text: "found it" }
      },
    })
    expect(liveDuringRun).toHaveLength(1)
    expect(liveDuringRun[0]).toMatchObject({ name: "scout", task: "look around", color: "cyan" })
    const settled = getLiveSubagent(liveDuringRun[0].liveId, "s1")
    expect(settled?.status).toBe("done")
    expect(settled?.text).toContain("hello")
  })

  it("settles the live entry to error when the run throws or is refused", async () => {
    const { dispatch } = recorder()
    await agentsDispatch("reviewer go", {
      dispatch,
      cwd: "/w",
      sessionId: "s2",
      list: async () => [agent("reviewer")],
      dispatchAgent: async () => {
        throw new Error("boom")
      },
    })
    expect(listLiveSubagents("s2")[0]?.status).toBe("error")
    await agentsDispatch("reviewer go", {
      dispatch,
      cwd: "/w",
      sessionId: "s3",
      list: async () => [agent("reviewer")],
      dispatchAgent: async () => ({
        text: "",
        rejection: { reason: "max-depth", message: "too deep" },
      }),
    })
    expect(listLiveSubagents("s3")[0]?.status).toBe("error")
  })

  it("detaches a --bg run into the background registry and returns immediately", async () => {
    const { dispatch, actions } = recorder()
    const startBackground = jest.fn()
    let release!: () => void
    const run = jest.fn(
      () =>
        new Promise<{ text: string }>((resolve) => {
          release = () => resolve({ text: "later" })
        })
    )
    await agentsDispatch("--bg reviewer long task", {
      dispatch,
      cwd: "/w",
      sessionId: "s4",
      home: "/home/.cognia",
      list: async () => [agent("reviewer")],
      dispatchAgent: run,
      startBackground,
      hasBackground: () => false,
      mintRunId: () => "bg-manual",
    })
    // Returned before the run settled, with the runId and the stop hint.
    expect(actions.at(-1)).toMatchObject({
      type: "NOTICE",
      message: expect.stringContaining("runId: bg-manual"),
    })
    expect((actions.at(-1) as { message: string }).message).toContain("/agents stop bg-manual")
    expect(actions.some((a) => a.type === "ACTIVITY_START")).toBe(false)
    expect(startBackground).toHaveBeenCalledTimes(1)
    const [runId, meta, promise] = startBackground.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Promise<{ text: string; error?: string }>,
    ]
    expect(runId).toBe("bg-manual")
    expect(meta).toMatchObject({
      kind: "subagent",
      subagentId: "reviewer",
      prompt: "long task",
      sessionId: "s4",
      host: "cli",
      mode: "background",
      home: "/home/.cognia",
    })
    // The live entry shares the background runId so the panel shows one row.
    expect(getLiveSubagent("bg-manual", "s4")?.status).toBe("running")
    release()
    await expect(promise).resolves.toMatchObject({ text: expect.stringContaining("later") })
    expect(getLiveSubagent("bg-manual", "s4")?.status).toBe("done")
  })

  it("refuses a --bg run whose minted id is already taken", async () => {
    const { dispatch, actions } = recorder()
    const startBackground = jest.fn()
    await agentsDispatch("--bg reviewer go", {
      dispatch,
      cwd: "/w",
      list: async () => [agent("reviewer")],
      dispatchAgent: async () => ({ text: "x" }),
      startBackground,
      hasBackground: () => true,
      mintRunId: () => "bg-dup",
    })
    expect(startBackground).not.toHaveBeenCalled()
    expect(actions.at(-1)).toMatchObject({ message: expect.stringContaining("already exists") })
  })
})

function memAuthoringFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const dirs = new Set<string>()
  const fs: AgentAuthoringFs = {
    exists: async (p) => files.has(p),
    mkdir: async (p) => {
      dirs.add(p)
    },
    writeText: async (p, text) => {
      files.set(p, text)
    },
    unlink: async (p) => {
      files.delete(p)
    },
  }
  return { fs, files, dirs }
}

describe("agentsNew / agentsRemove / agentsEditEffect", () => {
  it("scaffolds a parseable agent file with the optional-field guide", async () => {
    const { dispatch, actions } = recorder()
    const mem = memAuthoringFs()
    await agentsNew("code-reviewer reviews diffs for bugs", { dispatch, cwd: "/proj", fs: mem.fs })
    const file = agentFilePath("/proj", "code-reviewer")
    expect(mem.dirs.has("/proj/.cognia/agents")).toBe(true)
    const text = mem.files.get(file)!
    expect(text).toContain("description: reviews diffs for bugs")
    expect(text).toContain("# color: cyan")
    const parsed = parseMarkdownAgent("code-reviewer", text)
    if (!("def" in parsed)) throw new Error("expected a parseable agent file")
    expect(parsed.id).toBe("code-reviewer")
    expect(parsed.def.description).toBe("reviews diffs for bugs")
    expect(parsed.def.prompt).toContain("You are code-reviewer")
    expect(parsed.unsupportedFields).toEqual([])
    expect(actions.at(-1)).toMatchObject({
      message: expect.stringContaining("/agents edit code-reviewer"),
    })
  })

  it("defaults the description and rejects bad ids or an existing file", async () => {
    const { dispatch, actions } = recorder()
    const mem = memAuthoringFs()
    await agentsNew("scout", { dispatch, cwd: "/proj", fs: mem.fs })
    expect(mem.files.get(agentFilePath("/proj", "scout"))).toContain(
      "description: Custom subagent scout"
    )
    await agentsNew("scout", { dispatch, cwd: "/proj", fs: mem.fs })
    expect(actions.at(-1)).toMatchObject({ message: expect.stringContaining("already exists") })
    await agentsNew("bad!id", { dispatch, cwd: "/proj", fs: mem.fs })
    expect(actions.at(-1)).toMatchObject({
      message: expect.stringContaining("not a valid agent id"),
    })
    await agentsNew("", { dispatch, cwd: "/proj", fs: mem.fs })
    expect(actions.at(-1)).toMatchObject({ message: "Usage: /agents new <id> [description]" })
    expect(mem.files.size).toBe(1)
  })

  it("removes only a project file and explains what it will not touch", async () => {
    const { dispatch, actions } = recorder()
    const file = agentFilePath("/proj", "scout")
    const mem = memAuthoringFs({ [file]: "---\ndescription: x\n---\nbody" })
    await agentsRemove("ghost", { dispatch, cwd: "/proj", fs: mem.fs })
    expect(actions.at(-1)).toMatchObject({ message: expect.stringContaining("Built-in agents") })
    await agentsRemove("scout", { dispatch, cwd: "/proj", fs: mem.fs })
    expect(mem.files.has(file)).toBe(false)
    expect(actions.at(-1)).toMatchObject({ message: expect.stringContaining("Removed") })
    await agentsRemove("", { dispatch, cwd: "/proj", fs: mem.fs })
    expect(actions.at(-1)).toMatchObject({ message: "Usage: /agents rm <id>" })
  })

  it("opens the project file, falls back to the home root, else explains shadowing", () => {
    const project = agentFilePath("/proj", "scout")
    const home = agentFilePath("/home/.cognia", "scout")
    expect(
      agentsEditEffect("scout", {
        cwd: "/proj",
        home: "/home/.cognia",
        exists: (p) => p === project,
      })
    ).toEqual({ kind: "openFile", file: project })
    expect(
      agentsEditEffect("scout", { cwd: "/proj", home: "/home/.cognia", exists: (p) => p === home })
    ).toEqual({ kind: "openFile", file: home })
    expect(
      agentsEditEffect("Explore", { cwd: "/proj", home: "/home/.cognia", exists: () => false })
    ).toMatchObject({ kind: "notice", message: expect.stringContaining("/agents new Explore") })
    expect(agentsEditEffect("", { cwd: "/proj", exists: () => true })).toMatchObject({
      kind: "notice",
      message: "Usage: /agents edit <id>",
    })
  })

  it("renderStarterAgentFile keeps the guide inside the frontmatter fence", () => {
    const text = renderStarterAgentFile("x", "d")
    const [, frontmatter, body] = text.split("---\n")
    expect(frontmatter).toContain("# Optional fields")
    expect(body.trim().startsWith("You are x")).toBe(true)
  })
})
