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
    const entries = buildTeamCollabManifestEntries()
    const names = entries.map((e) => e.name).sort()
    expect(names).toEqual(Object.values(TEAM_TOOL_NAMES).sort())
    for (const e of entries) {
      expect(e.pluginId).toBe(TEAM_BUILTIN_PLUGIN_ID)
      expect(typeof e.description).toBe("string")
      expect(e.jsonSchema).toBeTruthy()
    }
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
  })
})
