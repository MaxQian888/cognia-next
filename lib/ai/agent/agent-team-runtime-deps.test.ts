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

describe("runTeammateTask", () => {
  it("posts broadcast then result_share in order on success", async () => {
    const team = makeTeam()
    const teammate = makeTeammate()
    seedStore(team, [makeLead(), teammate])
    const executeAgent = jest.fn(async () => ({ text: "Found 3 sources." }))
    const { runTeammateTask } = buildAgentTeamRuntimeDeps({ executeAgent })

    const out = await runTeammateTask({
      team,
      teammate,
      task: makeTask(),
      signal: new AbortController().signal,
    })

    expect(out).toEqual({ result: "Found 3 sources." })
    const messages = useAgentTeamStore.getState().getTeamMessages("team-1")
    expect(messages.map((m) => m.type)).toEqual(["broadcast", "result_share"])
    expect(messages[0]?.content).toBe("Starting: Gather sources")
    expect(messages[1]?.content).toBe("Found 3 sources.")
  })

  it("posts a system message and returns error on executeAgent rejection", async () => {
    const team = makeTeam()
    const teammate = makeTeammate()
    seedStore(team, [makeLead(), teammate])
    const executeAgent = jest.fn(async () => {
      throw new Error("provider unreachable")
    })
    const { runTeammateTask } = buildAgentTeamRuntimeDeps({ executeAgent })

    const out = await runTeammateTask({
      team,
      teammate,
      task: makeTask(),
      signal: new AbortController().signal,
    })

    expect(out.error).toBe("provider unreachable")
    expect(out.result).toBe("")
    const messages = useAgentTeamStore.getState().getTeamMessages("team-1")
    expect(messages.map((m) => m.type)).toEqual(["broadcast", "system"])
    expect(messages[1]?.content).toContain("provider unreachable")
  })

  it("posts shutdown and rethrows when the signal aborts", async () => {
    const team = makeTeam()
    const teammate = makeTeammate()
    seedStore(team, [makeLead(), teammate])
    const ac = new AbortController()
    const executeAgent = jest.fn(async () => {
      ac.abort(new Error("user-cancelled"))
      const err = new Error("aborted")
      ;(err as Error & { name: string }).name = "AbortError"
      throw err
    })
    const { runTeammateTask } = buildAgentTeamRuntimeDeps({ executeAgent })

    await expect(
      runTeammateTask({ team, teammate, task: makeTask(), signal: ac.signal })
    ).rejects.toThrow(/aborted/)

    const messages = useAgentTeamStore.getState().getTeamMessages("team-1")
    expect(messages.map((m) => m.type)).toEqual(["broadcast", "shutdown"])
  })

  it("truncates very long results before posting them", async () => {
    const team = makeTeam()
    const teammate = makeTeammate()
    seedStore(team, [makeLead(), teammate])
    const long = "x".repeat(2000)
    const executeAgent = jest.fn(async () => ({ text: long }))
    const { runTeammateTask } = buildAgentTeamRuntimeDeps({ executeAgent })

    await runTeammateTask({
      team,
      teammate,
      task: makeTask(),
      signal: new AbortController().signal,
    })

    const messages = useAgentTeamStore.getState().getTeamMessages("team-1")
    const resultMsg = messages.find((m) => m.type === "result_share")
    expect(resultMsg?.content.length).toBeLessThanOrEqual(1200)
    expect(resultMsg?.content.endsWith("…")).toBe(true)
  })
})

describe("runLeadPlanning", () => {
  it("posts system + plan_approval messages and returns the plan text", async () => {
    const team = makeTeam()
    const lead = makeLead()
    const teammate = makeTeammate()
    seedStore(team, [lead, teammate])
    const planText = '```json\n{ "summary": "Plan", "steps": [] }\n```'
    const executeAgent = jest.fn(async () => ({ text: planText }))
    const { runLeadPlanning } = buildAgentTeamRuntimeDeps({ executeAgent })

    const out = await runLeadPlanning!({
      team,
      lead,
      feedback: undefined,
      signal: new AbortController().signal,
    })

    expect(out.planText).toBe(planText)
    const messages = useAgentTeamStore.getState().getTeamMessages("team-1")
    expect(messages.map((m) => m.type)).toEqual(["system", "plan_approval"])
    expect(messages[0]?.content).toBe("Drafting plan…")
  })

  it("uses revision messaging when given feedback", async () => {
    const team = makeTeam()
    const lead = makeLead()
    seedStore(team, [lead, makeTeammate()])
    const executeAgent = jest.fn(async () => ({ text: "```json\n{}\n```" }))
    const { runLeadPlanning } = buildAgentTeamRuntimeDeps({ executeAgent })

    await runLeadPlanning!({
      team,
      lead,
      feedback: "Add tests",
      signal: new AbortController().signal,
    })

    const messages = useAgentTeamStore.getState().getTeamMessages("team-1")
    expect(messages[0]?.content).toBe("Revising plan with reviewer feedback…")
  })

  it("posts system on failure and rethrows", async () => {
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

    const messages = useAgentTeamStore.getState().getTeamMessages("team-1")
    expect(messages.map((m) => m.type)).toEqual(["system", "system"])
    expect(messages[1]?.content).toContain("planning blew up")
  })
})
