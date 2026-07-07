import {
  buildAgentTeamRuntimeDeps,
  buildTeammatePrompt,
  buildLeadPlanningPrompt,
} from "./agent-team-runtime-deps"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"

function makeTeam(overrides: Partial<AgentTeam> = {}): AgentTeam {
  return {
    id: "team-1",
    name: "Demo",
    description: "",
    task: "Investigate the topic.",
    status: "idle",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 2,
      executionMode: "coordinated",
      displayMode: "compact",
    },
    leadId: "lead-1",
    teammateIds: ["lead-1", "tm-1"],
    taskIds: ["task-1"],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(),
    ...overrides,
  }
}

function makeTeammate(overrides: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id: "tm-1",
    teamId: "team-1",
    name: "Researcher",
    description: "Gathers facts and primary sources",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
    ...overrides,
  }
}

function makeLead(overrides: Partial<AgentTeammate> = {}): AgentTeammate {
  return makeTeammate({
    id: "lead-1",
    name: "Lead",
    role: "lead",
    description: "Coordinates the team",
    ...overrides,
  })
}

function makeTask(overrides: Partial<AgentTeamTask> = {}): AgentTeamTask {
  return {
    id: "task-1",
    teamId: "team-1",
    title: "Gather sources",
    description: "Find 3 reputable sources on the topic.",
    status: "pending",
    priority: "normal",
    dependencies: [],
    tags: [],
    expectedOutput: "A bulleted list with URLs.",
    retryCount: 0,
    order: 0,
    createdAt: new Date(),
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    ...overrides,
  }
}

function seedStore(team: AgentTeam, teammates: AgentTeammate[]): void {
  const store = useAgentTeamStore.getState()
  store.upsertTeam(team)
  for (const m of teammates) {
    store.upsertTeammate(m)
  }
}

beforeEach(() => {
  useAgentTeamStore.getState().reset()
})

describe("buildTeammatePrompt", () => {
  it("includes team task, teammate role, and task title/description/expectedOutput", () => {
    const prompt = buildTeammatePrompt(makeTeam(), makeTeammate(), makeTask())
    expect(prompt).toContain("Investigate the topic.")
    expect(prompt).toContain("Gathers facts and primary sources")
    expect(prompt).toContain("Gather sources")
    expect(prompt).toContain("Find 3 reputable sources on the topic.")
    expect(prompt).toContain("A bulleted list with URLs.")
  })

  it("includes the teammate spawnPrompt when provided", () => {
    const teammate = makeTeammate({ spawnPrompt: "Focus on EU primary sources." })
    const prompt = buildTeammatePrompt(makeTeam(), teammate, makeTask())
    expect(prompt).toContain("Focus on EU primary sources.")
  })

  it("falls back to specialization when description is empty", () => {
    const teammate = makeTeammate({ description: "", config: { specialization: "research" } })
    const prompt = buildTeammatePrompt(makeTeam(), teammate, makeTask())
    expect(prompt).toContain("Your role: research")
  })
})

describe("buildLeadPlanningPrompt", () => {
  it("lists workers and asks for a JSON-fenced plan", () => {
    const prompt = buildLeadPlanningPrompt(
      makeTeam(),
      [
        makeTeammate({ id: "tm-1", name: "Researcher", description: "research" }),
        makeTeammate({ id: "tm-2", name: "Writer", description: "writing" }),
      ],
      undefined
    )
    expect(prompt).toContain("Researcher: research")
    expect(prompt).toContain("Writer: writing")
    expect(prompt).toContain("```json")
    expect(prompt).toContain("Investigate the topic.")
  })

  it("includes feedback when revising", () => {
    const prompt = buildLeadPlanningPrompt(makeTeam(), [makeTeammate()], "Add a verification step.")
    expect(prompt).toContain("Add a verification step.")
    expect(prompt).toContain("Revise the plan accordingly.")
  })
})

describe("buildAgentTeamRuntimeDeps", () => {
  it("exposes lead-planning, notifier, and the PR-feedback resolver seams", () => {
    const deps = buildAgentTeamRuntimeDeps()
    expect(typeof deps.runLeadPlanning).toBe("function")
    expect(deps.notifierDeps).toBeDefined()
    // PR feedback loop resolvers (ADR — team PR feedback) must be wired so the
    // loop is reachable when a team enables it.
    expect(typeof deps.resolveTeamRepo).toBe("function")
    expect(typeof deps.resolvePrObserveOctokit).toBe("function")
    expect(typeof deps.runPrReview).toBe("function")
  })
})

// runTeammateTask was deleted in the PR 4 cutover (ADR-0022 §3.9).
// Per-task dispatch now lives in the action.team.task.dispatch workflow node
// executor; its tests are in lib/workflow/nodes/built-ins.test.ts.

describe("runLeadPlanning", () => {
  // After the PR 4 cutover (ADR-0022 §3.9) runLeadPlanning is silent — it
  // returns planText from executeAgent and rethrows on failure. Message
  // posting moves to the synthesizer / UI gate.

  it("returns the plan text from executeAgent on success", async () => {
    const team = makeTeam()
    const lead = makeLead()
    seedStore(team, [lead, makeTeammate()])
    const planText = '```json\n{ "summary": "Plan", "steps": [] }\n```'
    const executeAgent = jest.fn(async () => ({
      text: planText,
      channel: "text" as const,
      toolsAvailable: false,
    }))
    const { runLeadPlanning } = buildAgentTeamRuntimeDeps({ executeAgent })

    const out = await runLeadPlanning!({
      team,
      lead,
      feedback: undefined,
      signal: new AbortController().signal,
    })

    expect(out.planText).toBe(planText)
    expect(executeAgent).toHaveBeenCalledTimes(1)
  })

  it("forwards feedback into the prompt during revisions", async () => {
    const team = makeTeam()
    const lead = makeLead()
    seedStore(team, [lead, makeTeammate()])
    const executeAgent = jest.fn(async () => ({
      text: "```json\n{}\n```",
      channel: "text" as const,
      toolsAvailable: false,
    }))
    const { runLeadPlanning } = buildAgentTeamRuntimeDeps({ executeAgent })

    await runLeadPlanning!({
      team,
      lead,
      feedback: "Add tests",
      signal: new AbortController().signal,
    })

    const firstCall = (executeAgent as jest.Mock).mock.calls[0]
    const prompt = firstCall?.[0] as string
    expect(prompt).toContain("Add tests")
    expect(prompt).toContain("Revise the plan accordingly")
  })

  it("rethrows executeAgent failures", async () => {
    const team = makeTeam()
    const lead = makeLead()
    seedStore(team, [lead, makeTeammate()])
    const executeAgent = jest.fn(async () => {
      throw new Error("planning blew up")
    })
    const { runLeadPlanning } = buildAgentTeamRuntimeDeps({ executeAgent })

    await expect(
      runLeadPlanning!({
        team,
        lead,
        feedback: undefined,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("planning blew up")
  })

  describe("lifecycle-hook bracketing (ADR-0040 follow-up)", () => {
    it("fires SessionStart, UserPromptSubmit, Stop, SessionEnd around a successful plan", async () => {
      const team = makeTeam()
      const lead = makeLead()
      seedStore(team, [lead, makeTeammate()])
      const executeAgent = jest.fn(async () => ({
        text: "```json\n{}\n```",
        channel: "text" as const,
        toolsAvailable: false,
      }))
      const events: string[] = []
      const firer = jest.fn(async (event: string) => {
        events.push(event)
        return null
      })
      const { runLeadPlanning } = buildAgentTeamRuntimeDeps({ executeAgent, firer })

      await runLeadPlanning!({
        team,
        lead,
        feedback: undefined,
        signal: new AbortController().signal,
      })

      expect(events).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"])
    })

    it("injects pre-hook additionalContext into the planning system prompt", async () => {
      const team = makeTeam()
      const lead = makeLead()
      seedStore(team, [lead, makeTeammate()])
      const executeAgent = jest.fn(async () => ({
        text: "```json\n{}\n```",
        channel: "text" as const,
        toolsAvailable: false,
      }))
      const firer = jest.fn(async (event: string) =>
        event === "SessionStart"
          ? { block: null, additionalContext: "TEAM CONTEXT", warnings: [] }
          : null
      )
      const { runLeadPlanning } = buildAgentTeamRuntimeDeps({ executeAgent, firer })

      await runLeadPlanning!({
        team,
        lead,
        feedback: undefined,
        signal: new AbortController().signal,
      })

      const opts = (executeAgent as jest.Mock).mock.calls[0]?.[1] as { systemPrompt: string }
      expect(opts.systemPrompt).toContain("TEAM CONTEXT")
    })

    it("fires StopFailure then SessionEnd when planning throws, then rethrows", async () => {
      const team = makeTeam()
      const lead = makeLead()
      seedStore(team, [lead, makeTeammate()])
      const executeAgent = jest.fn(async () => {
        throw new Error("boom")
      })
      const events: string[] = []
      const firer = jest.fn(async (event: string) => {
        events.push(event)
        return null
      })
      const { runLeadPlanning } = buildAgentTeamRuntimeDeps({ executeAgent, firer })

      await expect(
        runLeadPlanning!({
          team,
          lead,
          feedback: undefined,
          signal: new AbortController().signal,
        })
      ).rejects.toThrow("boom")
      expect(events).toEqual(["SessionStart", "UserPromptSubmit", "StopFailure", "SessionEnd"])
    })
  })
})
