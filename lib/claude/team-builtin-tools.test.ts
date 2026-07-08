/** @jest-environment jsdom */
/**
 * Team-collaboration built-in tools — manifest + host-side router.
 *
 * Uses injected fake deps so the routing / identity-binding logic is exercised
 * without the Zustand store or the delegation runtime.
 */

import "fake-indexeddb/auto"
import {
  TEAM_TOOL_NAMES,
  TEAM_BUILTIN_PLUGIN_ID,
  buildTeamCollabManifestEntries,
  defaultTeamToolDeps,
  isTeamBuiltinTool,
  runTeamBuiltinTool,
  type TeamToolCaller,
  type TeamToolDeps,
} from "./team-builtin-tools"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { ConsensusRequest, SharedMemoryEntry } from "@/types/agent/agent-team"

// Keep the background-delegation path off the real LLM / background runtime so
// the defaultTeamToolDeps `background` branch is safe to exercise.
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: jest.fn(async () => ({ text: "bg done" })),
}))
jest.mock("@/lib/ai/agent/background-agent-manager", () => ({
  getBackgroundAgentManager: () => ({
    registerAgent: () => new AbortController().signal,
    finishAgent: jest.fn(),
    cancelAgent: jest.fn(),
  }),
}))
// Twin runtime is dynamic-imported by defaultTeamToolDeps.searchTwinKnowledge.
const tryBuildTwinDepsMock = jest.fn()
jest.mock("@/lib/twin/runtime/build-deps", () => ({
  tryBuildTwinDeps: (...a: unknown[]) => tryBuildTwinDepsMock(...a),
}))
const runTwinSearchMock = jest.fn()
jest.mock("@/lib/ai/agent/team/twin-context", () => ({
  searchTwinKnowledge: (...a: unknown[]) => runTwinSearchMock(...a),
}))

const caller: TeamToolCaller = {
  teamId: "team-1",
  teammateId: "tm-a",
  teammateName: "Ada",
  runId: "run-1",
}

function makeDeps(over: Partial<TeamToolDeps> = {}): {
  deps: TeamToolDeps
  calls: Record<string, unknown[]>
} {
  const calls: Record<string, unknown[]> = {}
  const rec =
    (k: string) =>
    (...a: unknown[]) => {
      ;(calls[k] ??= []).push(a)
    }
  const deps: TeamToolDeps = {
    addMessage: rec("addMessage") as TeamToolDeps["addMessage"],
    publishEntry: ((input) => {
      rec("publishEntry")(input)
      return { key: input.key, version: 1 } as SharedMemoryEntry
    }) as TeamToolDeps["publishEntry"],
    listMemory: (() => [
      { key: "k1", value: "v1", writerName: "Bob" } as SharedMemoryEntry,
      { key: "k2", value: "v2", writerName: "Ada" } as SharedMemoryEntry,
    ]) as TeamToolDeps["listMemory"],
    createConsensus: ((input) => {
      rec("createConsensus")(input)
      return { id: "cons-1", ...input } as unknown as ConsensusRequest
    }) as TeamToolDeps["createConsensus"],
    castVote: ((input) => {
      rec("castVote")(input)
      return { id: input.consensusId, status: "open" } as unknown as ConsensusRequest
    }) as TeamToolDeps["castVote"],
    delegate: ((input) => {
      rec("delegate")(input)
      return { id: "del-1", status: "active" }
    }) as TeamToolDeps["delegate"],
    listMembers: (() => [{ id: "tm-a", name: "Ada", role: "lead" }]) as TeamToolDeps["listMembers"],
    recentMessages: (() => []) as TeamToolDeps["recentMessages"],
    addTaskComment: ((input) => {
      rec("addTaskComment")(input)
      return { id: "cmt-1" }
    }) as TeamToolDeps["addTaskComment"],
    getTask: ((taskId) => {
      rec("getTask")(taskId)
      return {
        id: taskId,
        title: "T",
        status: "in_progress",
        description: "d",
        comments: [
          { authorName: "Ada", text: "first finding", createdAt: "2026-06-29T00:00:00.000Z" },
        ],
      }
    }) as TeamToolDeps["getTask"],
    searchTwinKnowledge: (async (input) => {
      rec("searchTwinKnowledge")(input)
      return {
        ok: true,
        twinId: "tw1",
        hits: [{ text: "redacted passage", sourceTitle: "Doc", score: 0.9 }],
      }
    }) as TeamToolDeps["searchTwinKnowledge"],
    ...over,
  }
  return { deps, calls }
}

describe("team-builtin-tools manifest", () => {
  it("isTeamBuiltinTool recognises exactly the canonical names", () => {
    for (const n of Object.values(TEAM_TOOL_NAMES)) expect(isTeamBuiltinTool(n)).toBe(true)
    expect(isTeamBuiltinTool("Skill")).toBe(false)
    expect(isTeamBuiltinTool("team_unknown")).toBe(false)
  })

  it("every manifest entry is tagged + named, and every name is routable", () => {
    // With the twin knowledge tool enabled, the manifest covers every canonical name.
    const entries = buildTeamCollabManifestEntries({ includeTwinKnowledgeSearch: true })
    const names = entries.map((e) => e.name).sort()
    expect(names).toEqual(Object.values(TEAM_TOOL_NAMES).sort())
    for (const e of entries) {
      expect(e.pluginId).toBe(TEAM_BUILTIN_PLUGIN_ID)
      expect(typeof e.description).toBe("string")
      expect(e.jsonSchema).toBeTruthy()
    }
  })

  it("gates twin_knowledge_search behind includeTwinKnowledgeSearch", () => {
    const without = buildTeamCollabManifestEntries().map((e) => e.name)
    expect(without).not.toContain(TEAM_TOOL_NAMES.twinKnowledgeSearch)
    const withTool = buildTeamCollabManifestEntries({ includeTwinKnowledgeSearch: true }).map(
      (e) => e.name
    )
    expect(withTool).toContain(TEAM_TOOL_NAMES.twinKnowledgeSearch)
  })
})

describe("runTeamBuiltinTool", () => {
  it("rejects an unknown tool name", async () => {
    const { deps } = makeDeps()
    expect(await runTeamBuiltinTool("nope", {}, caller, deps)).toMatch(/unknown team tool/)
  })

  it("team_send_message broadcasts when no recipient, direct otherwise", async () => {
    const { deps, calls } = makeDeps()
    expect(
      await runTeamBuiltinTool(TEAM_TOOL_NAMES.sendMessage, { content: "hi" }, caller, deps)
    ).toMatch(/broadcast/)
    expect((calls.addMessage[0] as [{ type: string }])[0].type).toBe("broadcast")
    await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.sendMessage,
      { content: "yo", to: "tm-b" },
      caller,
      deps
    )
    expect((calls.addMessage[1] as [{ type: string; recipientId: string }])[0]).toMatchObject({
      type: "direct",
      recipientId: "tm-b",
    })
  })

  it("team_send_message rejects empty content", async () => {
    const { deps } = makeDeps()
    expect(
      await runTeamBuiltinTool(TEAM_TOOL_NAMES.sendMessage, { content: "  " }, caller, deps)
    ).toMatch(/requires non-empty/)
  })

  it("team_send_message suppresses idle/ack-only chatter without writing", async () => {
    const { deps, calls } = makeDeps()
    const out = await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.sendMessage,
      { content: "understood" },
      caller,
      deps
    )
    expect(out).toMatch(/Suppressed: idle\/ack/)
    expect(calls.addMessage).toBeUndefined()
  })

  it("team_send_message suppresses a duplicate of a recent message", async () => {
    const recent = [
      {
        senderId: caller.teammateId,
        content: "Deploy is green and stable.",
        createdAt: Date.now(),
      },
    ]
    const { deps, calls } = makeDeps({
      recentMessages: (() => recent) as TeamToolDeps["recentMessages"],
    })
    const out = await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.sendMessage,
      { content: "  deploy is GREEN and stable. " },
      caller,
      deps
    )
    expect(out).toMatch(/Suppressed: duplicate/)
    expect(calls.addMessage).toBeUndefined()
  })

  it("team_publish_memory writes with the caller as writer and surfaces PII errors", async () => {
    const { deps, calls } = makeDeps()
    const ok = await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.publishMemory,
      { key: "decision", value: "ship it", tags: ["x"] },
      caller,
      deps
    )
    expect(ok).toMatch(/Published "decision"/)
    expect((calls.publishEntry[0] as [{ writer: { id: string } }])[0].writer.id).toBe("tm-a")

    const piiDeps = makeDeps({
      publishEntry: () => {
        throw new Error("SharedMemory write blocked: PII detected")
      },
    }).deps
    expect(
      await runTeamBuiltinTool(
        TEAM_TOOL_NAMES.publishMemory,
        { key: "k", value: "v" },
        caller,
        piiDeps
      )
    ).toMatch(/PII detected/)
  })

  it("team_read_memory returns entries, filtered by keys when provided", async () => {
    const { deps } = makeDeps()
    const all = (await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.readMemory,
      {},
      caller,
      deps
    )) as unknown[]
    expect(all).toHaveLength(2)
    const filtered = (await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.readMemory,
      { keys: ["k2"] },
      caller,
      deps
    )) as Array<{ key: string }>
    expect(filtered).toEqual([{ key: "k2", value: "v2", writerName: "Ada" }])
  })

  it("team_request_consensus needs a question and >=2 options", async () => {
    const { deps, calls } = makeDeps()
    expect(
      await runTeamBuiltinTool(
        TEAM_TOOL_NAMES.requestConsensus,
        { question: "q", options: ["a"] },
        caller,
        deps
      )
    ).toMatch(/at least two/)
    const ok = await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.requestConsensus,
      { question: "Pick", options: ["a", "b"], type: "unanimous" },
      caller,
      deps
    )
    expect(ok).toMatch(/Consensus opened/)
    expect((calls.createConsensus[0] as [{ initiatorId: string; type: string }])[0]).toMatchObject({
      initiatorId: "tm-a",
      type: "unanimous",
    })
  })

  it("team_vote records the caller as voter and reports resolution", async () => {
    const resolvedDeps = makeDeps({
      castVote: () =>
        ({ id: "c", status: "resolved", winningOption: 1 }) as unknown as ConsensusRequest,
    }).deps
    expect(
      await runTeamBuiltinTool(
        TEAM_TOOL_NAMES.vote,
        { consensusId: "c", optionIndex: 1 },
        caller,
        resolvedDeps
      )
    ).toMatch(/consensus resolved \(option 2\)/)
  })

  it("team_delegate validates target and forwards source identity", async () => {
    const { deps, calls } = makeDeps()
    expect(
      await runTeamBuiltinTool(
        TEAM_TOOL_NAMES.delegate,
        { target: "nope", reason: "r" },
        caller,
        deps
      )
    ).toMatch(/must be background/)
    const ok = await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.delegate,
      { target: "background", reason: "offload", prompt: "do x" },
      caller,
      deps
    )
    expect(ok).toMatch(/Delegated to background/)
    expect((calls.delegate[0] as [{ sourceTeamId: string; target: string }])[0]).toMatchObject({
      sourceTeamId: "team-1",
      target: "background",
    })
  })

  it("team_list_members returns the roster", async () => {
    const { deps } = makeDeps()
    expect(await runTeamBuiltinTool(TEAM_TOOL_NAMES.listMembers, {}, caller, deps)).toEqual([
      { id: "tm-a", name: "Ada", role: "lead" },
    ])
  })

  it("team_delegate routes target=twin and requires a twinId", async () => {
    const { deps, calls } = makeDeps()
    expect(
      await runTeamBuiltinTool(
        TEAM_TOOL_NAMES.delegate,
        { target: "twin", reason: "ask the expert" },
        caller,
        deps
      )
    ).toMatch(/target=twin requires a `twinId`/)
    const ok = await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.delegate,
      { target: "twin", reason: "ask the expert", twinId: "tw1", prompt: "how?" },
      caller,
      deps
    )
    expect(ok).toMatch(/Delegated to twin/)
    expect((calls.delegate[0] as [{ target: string; twinId: string }])[0]).toMatchObject({
      target: "twin",
      twinId: "tw1",
    })
  })

  it("twin_knowledge_search requires a query and returns redacted hits", async () => {
    const { deps, calls } = makeDeps()
    expect(
      await runTeamBuiltinTool(TEAM_TOOL_NAMES.twinKnowledgeSearch, { query: "  " }, caller, deps)
    ).toMatch(/requires a non-empty `query`/)
    const out = await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.twinKnowledgeSearch,
      { query: "how to deploy", topK: 3 },
      caller,
      deps
    )
    expect(out).toMatchObject({ twinId: "tw1" })
    expect((out as { hits: Array<{ text: string }> }).hits[0]!.text).toBe("redacted passage")
    expect(
      (calls.searchTwinKnowledge[0] as [{ teamId: string; query: string; topK: number }])[0]
    ).toMatchObject({ teamId: "team-1", query: "how to deploy", topK: 3 })
  })

  it("twin_knowledge_search surfaces the dep error and the empty-hits case", async () => {
    const errDeps = makeDeps({
      searchTwinKnowledge: (async () => ({
        ok: false,
        error: "no sources",
      })) as TeamToolDeps["searchTwinKnowledge"],
    }).deps
    expect(
      await runTeamBuiltinTool(TEAM_TOOL_NAMES.twinKnowledgeSearch, { query: "q" }, caller, errDeps)
    ).toMatch(/Error: no sources/)
    const emptyDeps = makeDeps({
      searchTwinKnowledge: (async () => ({
        ok: true,
        twinId: "twX",
        hits: [],
      })) as TeamToolDeps["searchTwinKnowledge"],
    }).deps
    expect(
      await runTeamBuiltinTool(
        TEAM_TOOL_NAMES.twinKnowledgeSearch,
        { query: "q" },
        caller,
        emptyDeps
      )
    ).toMatch(/No knowledge found in twin "twX"/)
  })

  it("team_vote rejects a missing consensusId / non-integer option", async () => {
    const { deps } = makeDeps()
    expect(
      await runTeamBuiltinTool(TEAM_TOOL_NAMES.vote, { optionIndex: 0 }, caller, deps)
    ).toMatch(/requires `consensusId`/)
  })

  it("team_delegate falls back to a synthetic source task + default reason", async () => {
    const { deps, calls } = makeDeps()
    const callerNoRun: TeamToolCaller = {
      teamId: "team-1",
      teammateId: "tm-a",
      teammateName: "Ada",
    }
    await runTeamBuiltinTool(TEAM_TOOL_NAMES.delegate, { target: "background" }, callerNoRun, deps)
    expect((calls.delegate[0] as [{ sourceTaskId: string; reason: string }])[0]).toMatchObject({
      sourceTaskId: "adhoc:tm-a",
      reason: "delegated by teammate",
    })
  })

  it("team_vote forwards optional reasoning", async () => {
    const { deps, calls } = makeDeps()
    await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.vote,
      { consensusId: "c", optionIndex: 0, reasoning: "because" },
      caller,
      deps
    )
    expect((calls.castVote[0] as [{ reasoning: string }])[0].reasoning).toBe("because")
  })

  it("team_delegate forwards optional fields for team / external / background targets", async () => {
    const { deps, calls } = makeDeps()
    await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.delegate,
      { target: "team", reason: "r", targetTeamId: "t2", ultracode: true },
      caller,
      deps
    )
    await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.delegate,
      { target: "external", reason: "r", targetAgentId: "cc" },
      caller,
      deps
    )
    await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.delegate,
      { target: "background", reason: "r", prompt: "p", systemPrompt: "s" },
      caller,
      deps
    )
    expect(calls.delegate).toHaveLength(3)
    expect((calls.delegate[0] as [{ targetTeamId: string; ultracode: boolean }])[0]).toMatchObject({
      targetTeamId: "t2",
      ultracode: true,
    })
  })

  it("falls back to the default store-backed deps when none are injected", async () => {
    useAgentTeamStore.getState().reset()
    const r = await runTeamBuiltinTool(TEAM_TOOL_NAMES.listMembers, {}, caller)
    expect(Array.isArray(r)).toBe(true)
  })

  it("task_add_comment records a comment authored by the caller", async () => {
    const { deps, calls } = makeDeps()
    const out = await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.addTaskComment,
      {
        taskId: "task-9",
        content: "Root cause: stale cache key.",
        attachments: [
          { name: "patch.diff", kind: "file", ref: "fix/patch.diff" },
          { name: "bad", ref: "" }, // dropped: no ref
        ],
      },
      caller,
      deps
    )
    expect(out).toMatch(/Comment added to task-9/)
    const arg = (calls.addTaskComment[0] as [Record<string, unknown>])[0]
    expect(arg).toMatchObject({ taskId: "task-9", authorId: caller.teammateId })
    expect((arg.attachments as unknown[]).length).toBe(1)
  })

  it("task_add_comment validates taskId and content", async () => {
    const { deps } = makeDeps()
    expect(
      await runTeamBuiltinTool(TEAM_TOOL_NAMES.addTaskComment, { content: "x" }, caller, deps)
    ).toMatch(/requires a `taskId`/)
    expect(
      await runTeamBuiltinTool(
        TEAM_TOOL_NAMES.addTaskComment,
        { taskId: "t", content: "   " },
        caller,
        deps
      )
    ).toMatch(/requires non-empty/)
  })

  it("task_add_comment reports a missing task", async () => {
    const { deps } = makeDeps({ addTaskComment: (() => null) as TeamToolDeps["addTaskComment"] })
    expect(
      await runTeamBuiltinTool(
        TEAM_TOOL_NAMES.addTaskComment,
        { taskId: "ghost", content: "hi" },
        caller,
        deps
      )
    ).toMatch(/not found/)
  })

  it("task_get returns the task with its comment thread", async () => {
    const { deps } = makeDeps()
    const out = (await runTeamBuiltinTool(
      TEAM_TOOL_NAMES.getTask,
      { taskId: "task-9" },
      caller,
      deps
    )) as { comments: unknown[] }
    expect(out.comments).toHaveLength(1)
  })

  it("task_get validates taskId and reports a missing task", async () => {
    const { deps } = makeDeps()
    expect(await runTeamBuiltinTool(TEAM_TOOL_NAMES.getTask, {}, caller, deps)).toMatch(
      /requires a `taskId`/
    )
    const { deps: nullDeps } = makeDeps({ getTask: (() => null) as TeamToolDeps["getTask"] })
    expect(
      await runTeamBuiltinTool(TEAM_TOOL_NAMES.getTask, { taskId: "ghost" }, caller, nullDeps)
    ).toMatch(/not found/)
  })

  it("never throws — a dep that throws becomes an Error string", async () => {
    const boom = makeDeps({
      listMembers: () => {
        throw new Error("store down")
      },
    }).deps
    expect(await runTeamBuiltinTool(TEAM_TOOL_NAMES.listMembers, {}, caller, boom)).toMatch(
      /store down/
    )
  })
})

describe("defaultTeamToolDeps (real store-backed orchestrators)", () => {
  beforeEach(() => {
    useAgentTeamStore.getState().reset()
  })

  it("wires every dep through to the real store / orchestrators", async () => {
    const deps = await defaultTeamToolDeps()

    // message → store
    deps.addMessage({
      teamId: "team-1",
      senderId: "tm-a",
      type: "broadcast",
      content: "hello team",
    })
    expect(Object.values(useAgentTeamStore.getState().messages)).toHaveLength(1)

    // publish + read back blackboard
    deps.publishEntry({
      teamId: "team-1",
      key: "k",
      value: "clean value",
      writer: { id: "tm-a", name: "Ada" },
    })
    const entries = deps.listMemory("team-1", "tm-a")
    expect(entries.map((e) => e.key)).toContain("k")

    // consensus create + vote
    const cons = deps.createConsensus({
      teamId: "team-1",
      initiatorId: "tm-a",
      question: "Ship?",
      options: ["yes", "no"],
    })
    expect(useAgentTeamStore.getState().consensus[cons.id]).toBeDefined()
    const voted = deps.castVote({ consensusId: cons.id, voterId: "tm-a", optionIndex: 0 })
    expect(voted.votes).toHaveLength(1)

    // delegate — all three target branches (background uses the mocked runtime)
    const delExt = deps.delegate({
      target: "external",
      sourceTeamId: "team-1",
      sourceTaskId: "task-1",
      reason: "offload",
      targetAgentId: "claude-code",
    })
    expect(useAgentTeamStore.getState().delegations[delExt.id]).toBeDefined()

    const delTeam = deps.delegate({
      target: "team",
      sourceTeamId: "team-1",
      sourceTaskId: "task-1",
      reason: "handoff",
      targetTeamId: "team-2",
      ultracode: true,
    })
    expect(useAgentTeamStore.getState().delegations[delTeam.id]).toBeDefined()

    const delBg = deps.delegate({
      target: "background",
      sourceTeamId: "team-1",
      sourceTaskId: "task-1",
      reason: "offload bg",
      prompt: "do work",
      systemPrompt: "be terse",
    })
    expect(useAgentTeamStore.getState().delegations[delBg.id]).toBeDefined()

    // members roster reflects the store
    useAgentTeamStore.setState(
      (s) =>
        ({
          teammates: {
            ...s.teammates,
            "tm-a": { id: "tm-a", teamId: "team-1", name: "Ada", role: "lead" },
          },
        }) as never
    )
    const members = deps.listMembers("team-1")
    expect(members.some((m) => m.id === "tm-a")).toBe(true)

    // task comment round-trip through the store
    const team = useAgentTeamStore.getState().createTeam({ name: "RT", task: "t" })
    const task = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "Task", description: "" })

    // recentMessages reflects a broadcast on a real team (getTeamMessages needs the team)
    deps.addMessage({ teamId: team.id, senderId: "tm-a", type: "broadcast", content: "hello team" })
    const recent = deps.recentMessages(team.id)
    expect(recent.some((m) => m.content === "hello team")).toBe(true)
    const added = deps.addTaskComment({
      taskId: task.id,
      authorId: "tm-a",
      text: "found the bug",
      attachments: [{ name: "log", kind: "file", ref: "logs/a.txt" }],
    })
    expect(added?.id).toBeTruthy()
    const fetched = deps.getTask(task.id)
    expect(fetched?.comments).toHaveLength(1)
    expect(fetched?.comments[0].text).toBe("found the bug")
    expect(deps.addTaskComment({ taskId: "ghost", authorId: "tm-a", text: "x" })).toBeNull()
    expect(deps.getTask("ghost")).toBeNull()
  })
})

describe("defaultTeamToolDeps.searchTwinKnowledge (authorization + redaction)", () => {
  beforeEach(() => {
    useAgentTeamStore.getState().reset()
    tryBuildTwinDepsMock.mockReset()
    runTwinSearchMock.mockReset()
  })

  it("errors when the team has no digital-employee knowledge sources", async () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "t" })
    const deps = await defaultTeamToolDeps()
    const res = await deps.searchTwinKnowledge({ teamId: team.id, query: "q" })
    expect(res.ok).toBe(false)
    expect((res as { ok: false; error: string }).error).toMatch(/no digital-employee knowledge/)
    expect(runTwinSearchMock).not.toHaveBeenCalled()
  })

  it("rejects a twinId that is not an authorized source", async () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "t" })
    const cfg = useAgentTeamStore.getState().teams[team.id]!.config
    useAgentTeamStore.getState().updateTeamConfig(team.id, { ...cfg, knowledgeTwinIds: ["tw1"] })
    const deps = await defaultTeamToolDeps()
    const res = await deps.searchTwinKnowledge({ teamId: team.id, query: "q", twinId: "other" })
    expect(res.ok).toBe(false)
    expect((res as { ok: false; error: string }).error).toMatch(/not an authorized/)
  })

  it("errors when the twin runtime is unavailable", async () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "t" })
    const cfg = useAgentTeamStore.getState().teams[team.id]!.config
    useAgentTeamStore.getState().updateTeamConfig(team.id, { ...cfg, knowledgeTwinIds: ["tw1"] })
    tryBuildTwinDepsMock.mockResolvedValue(undefined)
    const deps = await defaultTeamToolDeps()
    const res = await deps.searchTwinKnowledge({ teamId: team.id, query: "q" })
    expect(res.ok).toBe(false)
    expect((res as { ok: false; error: string }).error).toMatch(/twin runtime is not configured/)
  })

  it("returns redacted hits for an authorized member-bound twin", async () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "t" })
    useAgentTeamStore.getState().addTeammate({
      teamId: team.id,
      name: "Member",
      role: "teammate",
      config: { twinId: "twMember" },
    })
    tryBuildTwinDepsMock.mockResolvedValue({ store: {}, embedding: {} })
    runTwinSearchMock.mockResolvedValue({
      hits: [{ text: "REDACTED passage", sourceTitle: "Doc", score: 0.9 }],
      degraded: false,
    })
    const deps = await defaultTeamToolDeps()
    const res = await deps.searchTwinKnowledge({ teamId: team.id, query: "how" })
    expect(res).toMatchObject({ ok: true, twinId: "twMember" })
    expect((res as { ok: true; hits: Array<{ text: string }> }).hits[0]!.text).toBe(
      "REDACTED passage"
    )
    expect(runTwinSearchMock).toHaveBeenCalledWith(
      expect.objectContaining({ twinId: "twMember", query: "how" })
    )
  })
})
