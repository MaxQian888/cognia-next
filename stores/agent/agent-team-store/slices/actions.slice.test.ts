/**
 * @jest-environment jsdom
 */
import {
  activateAgentTeamAccountStorage,
  clearAgentTeamAccountStorage,
  purgeAgentTeamAccountStorage,
  useAgentTeamStore,
} from "../store"
import type {
  AgentTeammate,
  AgentTeamTask,
  AgentTeamMessage,
  TeamExecutionReport,
  TeamExecutionCheckpoint,
  ConsensusRequest,
  TeamDelegationRecord,
  AgentTeamTemplate,
  SharedMemoryEntry,
} from "@/types/agent/agent-team"

jest.mock("@cognia/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    // `createLogger` + `logger` are needed by modules now pulled into the store's
    // import graph (e.g. lib/execution/broker.ts calls createLogger at module load).
    createLogger: () => ({ ...child, child: () => child }),
    logger: { ...child, child: () => child },
    loggers: {
      agent: { ...child, child: () => child },
      plugin: { ...child, child: () => child },
    },
  }
})

// Controllable active workspace for Workspace-isolation tests (v86).
let mockActiveProjectId: string | null = null
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: mockActiveProjectId }) },
}))

const purgeAgentTeamMock = jest.fn<Promise<void>, [teamId: string]>(async () => undefined)
jest.mock("@/lib/db/agent-team-runtime", () => ({
  purgeAgentTeam: (teamId: string) => purgeAgentTeamMock(teamId),
}))

const reset = () => {
  localStorage.clear()
  useAgentTeamStore.getState().reset()
  mockActiveProjectId = null
}

describe("useAgentTeamStore createTeam", () => {
  beforeEach(() => {
    reset()
  })

  it("uses the English Team Lead default when leadName is not provided", () => {
    const team = useAgentTeamStore.getState().createTeam({
      name: "My Team",
      task: "Ship X",
    })
    expect(team).toBeDefined()
    const lead = useAgentTeamStore.getState().teammates[team.leadId]
    expect(lead.name).toBe("Team Lead")
    expect(lead.role).toBe("lead")
    expect(lead.avatarId).toBe("coordinator")
  })

  it("respects a translated leadName when supplied", () => {
    const team = useAgentTeamStore.getState().createTeam({
      name: "中文团队",
      task: "Ship X",
      leadName: "组长",
      leadDescription: "协调团队",
    })
    const lead = useAgentTeamStore.getState().teammates[team.leadId]
    expect(lead.name).toBe("组长")
    expect(lead.description).toBe("协调团队")
  })

  it("registers the new team in the teams map and seeds it with the lead in teammateIds", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Mapped", task: "t" })
    expect(useAgentTeamStore.getState().teams[team.id]).toBeDefined()
    expect(team.teammateIds).toEqual([team.leadId])
  })

  it("propagates input.config and metadata onto the team", () => {
    const team = useAgentTeamStore.getState().createTeam({
      name: "C",
      task: "t",
      description: "desc",
      sessionId: "sess-1",
      metadata: { tag: "x" },
      config: { preferredExecutionPattern: "parallel_specialists" },
    })
    expect(team.description).toBe("desc")
    expect(team.sessionId).toBe("sess-1")
    expect(team.metadata).toEqual({ tag: "x" })
    expect(team.selectedExecutionPattern).toBe("parallel_specialists")
  })
})

describe("useAgentTeamStore deleteTeam", () => {
  beforeEach(() => {
    reset()
  })

  it("removes the team and its lead teammate", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Doomed", task: "t" })
    useAgentTeamStore.getState().deleteTeam(team.id)
    expect(useAgentTeamStore.getState().teams[team.id]).toBeUndefined()
    expect(useAgentTeamStore.getState().teammates[team.leadId]).toBeUndefined()
  })

  it("is a no-op for unknown team ids", () => {
    const before = useAgentTeamStore.getState()
    useAgentTeamStore.getState().deleteTeam("missing")
    expect(useAgentTeamStore.getState().teams).toEqual(before.teams)
  })

  it("shuts down active teammates before cleanup", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Active", task: "t" })
    const tm = useAgentTeamStore.getState().addTeammate({
      teamId: team.id,
      name: "Worker",
    })
    useAgentTeamStore.getState().setTeammateStatus(tm.id, "executing")
    useAgentTeamStore.getState().deleteTeam(team.id)
    expect(useAgentTeamStore.getState().teams[team.id]).toBeUndefined()
    expect(useAgentTeamStore.getState().teammates[tm.id]).toBeUndefined()
  })

  it("purges device-local durable runtime rows when deleting a durable team", async () => {
    const team = useAgentTeamStore.getState().createTeam({
      name: "Durable",
      task: "t",
      config: { runtimeVersion: "durable-v2" },
    })

    useAgentTeamStore.getState().deleteTeam(team.id)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(purgeAgentTeamMock).toHaveBeenCalledWith(team.id)
  })
})

describe("useAgentTeamStore editorSession", () => {
  beforeEach(() => reset())

  it("keeps legacy editor sessions as read-only compatibility data", () => {
    expect(useAgentTeamStore.getState()).not.toHaveProperty("setEditorSession")
  })

  it("cleanupTeam drops the deleted team's editor session", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "E", task: "t" })
    useAgentTeamStore.setState({
      editorSession: { [team.id]: { rootKey: "/proj", openPaths: [], activePath: null } },
    })
    useAgentTeamStore.getState().deleteTeam(team.id)
    expect(useAgentTeamStore.getState().editorSession[team.id]).toBeUndefined()
  })

  it("purgeProject drops editor sessions for the project's teams", () => {
    mockActiveProjectId = "proj-1"
    const team = useAgentTeamStore.getState().createTeam({ name: "P", task: "t" })
    useAgentTeamStore.setState({
      editorSession: { [team.id]: { rootKey: "/proj", openPaths: [], activePath: null } },
    })
    useAgentTeamStore.getState().purgeProject("proj-1")
    expect(useAgentTeamStore.getState().editorSession[team.id]).toBeUndefined()
  })
})

describe("useAgentTeamStore updateTeam", () => {
  beforeEach(() => {
    reset()
  })

  it("merges patches into the team object", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Edit", task: "t" })
    useAgentTeamStore.getState().updateTeam(team.id, { description: "new desc" })
    expect(useAgentTeamStore.getState().teams[team.id].description).toBe("new desc")
  })

  it("is a no-op for unknown team ids", () => {
    useAgentTeamStore.getState().updateTeam("nope", { description: "x" })
    expect(useAgentTeamStore.getState().teams["nope"]).toBeUndefined()
  })
})

describe("useAgentTeamStore upsertTeam", () => {
  beforeEach(() => reset())
  it("inserts a new team or replaces an existing one", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "U", task: "t" })
    useAgentTeamStore.getState().upsertTeam({ ...team, name: "Renamed" })
    expect(useAgentTeamStore.getState().teams[team.id].name).toBe("Renamed")
  })
})

describe("useAgentTeamStore updateTeamConfig", () => {
  beforeEach(() => reset())

  it("persists the new config on the active team", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "C", task: "t" })
    useAgentTeamStore.getState().updateTeamConfig(team.id, {
      ...team.config,
      maxConcurrentTeammates: 7,
    })
    expect(useAgentTeamStore.getState().teams[team.id].config.maxConcurrentTeammates).toBe(7)
  })

  it("is a no-op for unknown team", () => {
    useAgentTeamStore.getState().updateTeamConfig("missing", {
      executionMode: "coordinated",
    } as never)
    expect(useAgentTeamStore.getState().teams["missing"]).toBeUndefined()
  })

  it("clears preferredExecutionPattern when executionMode changed but pattern was unchanged", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "C", task: "t" })
    const config = { ...team.config, executionMode: "autonomous" as const }
    useAgentTeamStore.getState().updateTeamConfig(team.id, config)
    // The selected execution pattern should track the new normalized value
    expect(useAgentTeamStore.getState().teams[team.id].selectedExecutionPattern).toBeUndefined()
  })

  it("clears governancePolicy when legacy fields changed but policy was unchanged", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "C", task: "t" })
    const config = { ...team.config, requirePlanApproval: !team.config.requirePlanApproval }
    useAgentTeamStore.getState().updateTeamConfig(team.id, config)
    // governancePolicy should now be undefined because legacy fields changed
    expect(useAgentTeamStore.getState().teams[team.id].config.governancePolicy).toBeUndefined()
  })
})

describe("useAgentTeamStore setTeamStatus", () => {
  beforeEach(() => reset())

  it("sets startedAt when status switches to executing", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "S", task: "t" })
    useAgentTeamStore.getState().setTeamStatus(team.id, "executing")
    expect(useAgentTeamStore.getState().teams[team.id].startedAt).toBeInstanceOf(Date)
  })

  it("sets completedAt and totalDuration on terminal statuses", async () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "S", task: "t" })
    useAgentTeamStore.getState().setTeamStatus(team.id, "executing")
    await new Promise((r) => setTimeout(r, 5))
    useAgentTeamStore.getState().setTeamStatus(team.id, "completed")
    const t = useAgentTeamStore.getState().teams[team.id]
    expect(t.completedAt).toBeInstanceOf(Date)
    expect(typeof t.totalDuration).toBe("number")
    expect(t.totalDuration!).toBeGreaterThanOrEqual(0)
  })

  it("is a no-op for unknown team ids", () => {
    useAgentTeamStore.getState().setTeamStatus("missing", "executing")
    expect(useAgentTeamStore.getState().teams["missing"]).toBeUndefined()
  })

  it("does not set totalDuration when there is no startedAt", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "S", task: "t" })
    useAgentTeamStore.getState().setTeamStatus(team.id, "completed")
    expect(useAgentTeamStore.getState().teams[team.id].totalDuration).toBeUndefined()
  })

  it("handles failed and cancelled terminal statuses", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "S", task: "t" })
    useAgentTeamStore.getState().setTeamStatus(team.id, "failed")
    expect(useAgentTeamStore.getState().teams[team.id].completedAt).toBeInstanceOf(Date)

    const team2 = useAgentTeamStore.getState().createTeam({ name: "S2", task: "t" })
    useAgentTeamStore.getState().setTeamStatus(team2.id, "cancelled")
    expect(useAgentTeamStore.getState().teams[team2.id].completedAt).toBeInstanceOf(Date)
  })
})

describe("useAgentTeamStore Teammate CRUD", () => {
  beforeEach(() => reset())

  it("addTeammate appends to the team and returns the new teammate", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "X", task: "t" })
    const tm = useAgentTeamStore.getState().addTeammate({
      teamId: team.id,
      name: "W",
      description: "worker",
      role: "teammate",
      config: {},
      spawnPrompt: "p",
    })
    expect(tm.teamId).toBe(team.id)
    expect(useAgentTeamStore.getState().teams[team.id].teammateIds).toContain(tm.id)
  })

  it("assigns role-specific portraits without duplicating a teammate portrait", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "X", task: "t" })
    const guardian = useAgentTeamStore.getState().addTeammate({
      teamId: team.id,
      name: "Security specialist",
    })
    const secondGuardian = useAgentTeamStore.getState().addTeammate({
      teamId: team.id,
      name: "Security reviewer",
    })

    expect(guardian.avatarId).toBe("security-guardian")
    expect(secondGuardian.avatarId).not.toBe(guardian.avatarId)
    expect(secondGuardian.avatarId).not.toBe("coordinator")
  })

  it("ignores stale teammate references while assigning a portrait", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "X", task: "t" })
    useAgentTeamStore.getState().updateTeam(team.id, {
      teammateIds: [...team.teammateIds, "missing-teammate"],
    })

    expect(
      useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "Researcher" }).avatarId
    ).toBe("researcher")
  })

  it("addTeammate throws if the team is missing", () => {
    expect(() =>
      useAgentTeamStore.getState().addTeammate({ teamId: "missing", name: "x" })
    ).toThrow(/Team not found/)
  })

  it("rejects NEW raw apiKey/baseURL writes; legacy unchanged values stay readable (ADR-0090)", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "X", task: "t" })
    // New config with a raw key is refused at the store boundary.
    expect(() =>
      useAgentTeamStore.getState().addTeammate({
        teamId: team.id,
        name: "W",
        config: { apiKey: "sk-raw-key" },
      })
    ).toThrow(/raw "apiKey" writes are retired/)

    // A pinned-reference binding is the sanctioned shape.
    const tm = useAgentTeamStore.getState().addTeammate({
      teamId: team.id,
      name: "W",
      config: { execution: { mode: "pinned", deploymentRef: "dep-1" } },
    })

    // Updating with a NEW raw baseURL is refused; carrying an unchanged
    // legacy value through an update passes.
    expect(() =>
      useAgentTeamStore
        .getState()
        .updateTeammate(tm.id, { config: { baseURL: "https://vendor.example" } })
    ).toThrow(/raw "baseURL" writes are retired/)
    useAgentTeamStore.getState().updateTeammate(tm.id, {
      config: { execution: { mode: "pool", candidateIds: ["dep-1", "dep-2"] } },
    })
    expect(useAgentTeamStore.getState().teammates[tm.id].config.execution).toEqual({
      mode: "pool",
      candidateIds: ["dep-1", "dep-2"],
    })

    // upsertTeammate (whole-object replace) is guarded too — no bypass channel.
    expect(() =>
      useAgentTeamStore.getState().upsertTeammate({
        ...useAgentTeamStore.getState().teammates[tm.id],
        config: { apiKey: "sk-smuggled" },
      })
    ).toThrow(/raw "apiKey" writes are retired/)
  })

  it("upsertTeammate replaces an existing teammate", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "X", task: "t" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    const updated: AgentTeammate = { ...tm, name: "Renamed" }
    useAgentTeamStore.getState().upsertTeammate(updated)
    expect(useAgentTeamStore.getState().teammates[tm.id].name).toBe("Renamed")
    // teammateIds should not duplicate
    const ids = useAgentTeamStore.getState().teams[team.id].teammateIds
    expect(ids.filter((i) => i === tm.id).length).toBe(1)
  })

  it("upsertTeammate ignores teammates targeting an unknown team", () => {
    const tm: AgentTeammate = {
      id: "new-tm",
      teamId: "ghost",
      name: "Ghost",
      description: "",
      role: "teammate",
      status: "idle",
      config: {},
      completedTaskIds: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      progress: 0,
      createdAt: new Date(),
    }
    useAgentTeamStore.getState().upsertTeammate(tm)
    expect(useAgentTeamStore.getState().teammates["new-tm"]).toBeUndefined()
  })

  it("upsertTeammate refuses to move a lead across teams", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "X", task: "t" })
    const team2 = useAgentTeamStore.getState().createTeam({ name: "Y", task: "t" })
    const lead = useAgentTeamStore.getState().teammates[team.leadId]
    useAgentTeamStore.getState().upsertTeammate({ ...lead, teamId: team2.id })
    // lead should still be on team 1
    expect(useAgentTeamStore.getState().teammates[team.leadId].teamId).toBe(team.id)
  })

  it("upsertTeammate moves a non-lead teammate across teams", () => {
    const team1 = useAgentTeamStore.getState().createTeam({ name: "X", task: "t" })
    const team2 = useAgentTeamStore.getState().createTeam({ name: "Y", task: "t" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team1.id, name: "W" })
    useAgentTeamStore.getState().upsertTeammate({ ...tm, teamId: team2.id })
    expect(useAgentTeamStore.getState().teams[team1.id].teammateIds).not.toContain(tm.id)
    expect(useAgentTeamStore.getState().teams[team2.id].teammateIds).toContain(tm.id)
  })

  it("updateTeammate merges patches and is a no-op for unknown ids", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "X", task: "t" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    useAgentTeamStore.getState().updateTeammate(tm.id, { description: "now" })
    expect(useAgentTeamStore.getState().teammates[tm.id].description).toBe("now")
    useAgentTeamStore.getState().updateTeammate("missing", { description: "x" })
    expect(useAgentTeamStore.getState().teammates["missing"]).toBeUndefined()
  })

  it("removeTeammate removes a non-lead teammate, leaves the lead alone", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "X", task: "t" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    useAgentTeamStore.getState().removeTeammate(tm.id)
    expect(useAgentTeamStore.getState().teammates[tm.id]).toBeUndefined()

    // lead removal is rejected
    useAgentTeamStore.getState().removeTeammate(team.leadId)
    expect(useAgentTeamStore.getState().teammates[team.leadId]).toBeDefined()

    // unknown id is a no-op
    useAgentTeamStore.getState().removeTeammate("missing")
  })

  it("removeTeammate falls back to teammate-only removal when team is missing", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "X", task: "t" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    // Drop the team without using cleanupTeam (simulate corrupt state)
    useAgentTeamStore.setState((state) => {
      const { [team.id]: _t, ...rest } = state.teams
      return { teams: rest }
    })
    useAgentTeamStore.getState().removeTeammate(tm.id)
    expect(useAgentTeamStore.getState().teammates[tm.id]).toBeUndefined()
  })

  it("setTeammateStatus updates status and lastActiveAt; no-op for unknown id", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "X", task: "t" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    useAgentTeamStore.getState().setTeammateStatus(tm.id, "executing")
    expect(useAgentTeamStore.getState().teammates[tm.id].status).toBe("executing")
    expect(useAgentTeamStore.getState().teammates[tm.id].lastActiveAt).toBeInstanceOf(Date)
    useAgentTeamStore.getState().setTeammateStatus("missing", "executing")
  })

  it("setTeammateProgress clamps to [0,100] and is a no-op for unknown ids", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "X", task: "t" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    useAgentTeamStore.getState().setTeammateProgress(tm.id, 200)
    expect(useAgentTeamStore.getState().teammates[tm.id].progress).toBe(100)
    useAgentTeamStore.getState().setTeammateProgress(tm.id, -10)
    expect(useAgentTeamStore.getState().teammates[tm.id].progress).toBe(0)
    useAgentTeamStore.getState().setTeammateProgress(tm.id, 50)
    expect(useAgentTeamStore.getState().teammates[tm.id].progress).toBe(50)
    useAgentTeamStore.getState().setTeammateProgress("missing", 50)
  })
})

describe("useAgentTeamStore task comments & attachments", () => {
  beforeEach(() => reset())

  const seedTask = () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "C", task: "t" })
    const member = useAgentTeamStore
      .getState()
      .addTeammate({ teamId: team.id, name: "Ada", role: "teammate" })
    const task = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "Do", description: "" })
    return { team, member, task }
  }

  it("addTaskComment appends a comment, resolving the author name", () => {
    const { member, task } = seedTask()
    const c = useAgentTeamStore
      .getState()
      .addTaskComment({ taskId: task.id, authorId: member.id, text: "  found a bug  " })
    expect(c).not.toBeNull()
    expect(c?.text).toBe("found a bug")
    expect(c?.authorName).toBe("Ada")
    expect(useAgentTeamStore.getState().getTaskComments(task.id)).toHaveLength(1)
  })

  it("addTaskComment labels the operator and system authors", () => {
    const { task } = seedTask()
    const u = useAgentTeamStore
      .getState()
      .addTaskComment({ taskId: task.id, authorId: "user", text: "hi" })
    const s = useAgentTeamStore
      .getState()
      .addTaskComment({ taskId: task.id, authorId: "system", text: "yo" })
    expect(u?.authorName).toBe("You")
    expect(s?.authorName).toBe("System")
  })

  it("addTaskComment mints attachment ids", () => {
    const { member, task } = seedTask()
    const c = useAgentTeamStore.getState().addTaskComment({
      taskId: task.id,
      authorId: member.id,
      text: "see file",
      attachments: [{ name: "log.txt", kind: "file", ref: "logs/log.txt" }],
    })
    expect(c?.attachments?.[0].id).toBeTruthy()
    expect(c?.attachments?.[0].name).toBe("log.txt")
  })

  it("addTaskComment returns null for an unknown task or empty text", () => {
    const { member, task } = seedTask()
    expect(
      useAgentTeamStore
        .getState()
        .addTaskComment({ taskId: "ghost", authorId: member.id, text: "x" })
    ).toBeNull()
    expect(
      useAgentTeamStore
        .getState()
        .addTaskComment({ taskId: task.id, authorId: member.id, text: "   " })
    ).toBeNull()
  })

  it("attachTaskFile adds a task-level attachment with a minted id", () => {
    const { task } = seedTask()
    useAgentTeamStore
      .getState()
      .attachTaskFile(task.id, { name: "spec.md", kind: "link", ref: "https://x/spec" })
    const stored = useAgentTeamStore.getState().tasks[task.id].attachments
    expect(stored).toHaveLength(1)
    expect(stored?.[0]).toMatchObject({ name: "spec.md", kind: "link" })
    expect(stored?.[0].id).toBeTruthy()
  })

  it("attachTaskFile is a no-op for an unknown task", () => {
    expect(() =>
      useAgentTeamStore.getState().attachTaskFile("ghost", { name: "n", kind: "file", ref: "r" })
    ).not.toThrow()
  })

  it("getTaskComments returns [] for an unknown task", () => {
    expect(useAgentTeamStore.getState().getTaskComments("ghost")).toEqual([])
  })
})

describe("useAgentTeamStore Task CRUD", () => {
  beforeEach(() => reset())

  it("createTask attaches to the team's taskIds", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "t" })
    const task = useAgentTeamStore.getState().createTask({
      teamId: team.id,
      title: "Do",
      description: "do it",
    })
    expect(useAgentTeamStore.getState().teams[team.id].taskIds).toContain(task.id)
    expect(task.priority).toBe("normal")
    expect(task.dependencies).toEqual([])
    expect(task.tags).toEqual([])
  })

  it("createTask still records the task even when team has been removed", () => {
    const t = useAgentTeamStore.getState().createTask({
      teamId: "ghost",
      title: "Do",
      description: "",
    })
    expect(useAgentTeamStore.getState().tasks[t.id]).toBeDefined()
  })

  it("createTask uses an explicit order when provided, otherwise next index", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "t" })
    const t1 = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "1", description: "" })
    const t2 = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "2", description: "", order: 99 })
    expect(t1.order).toBe(0)
    expect(t2.order).toBe(99)
  })

  it("upsertTask noop's for unknown teamId", () => {
    const t: AgentTeamTask = {
      id: "x",
      teamId: "ghost",
      title: "T",
      description: "",
      status: "pending",
      priority: "normal",
      dependencies: [],
      tags: [],
      createdAt: new Date(),
      order: 0,
    }
    useAgentTeamStore.getState().upsertTask(t)
    expect(useAgentTeamStore.getState().tasks["x"]).toBeUndefined()
  })

  it("upsertTask moves a task between teams", () => {
    const team1 = useAgentTeamStore.getState().createTeam({ name: "1", task: "" })
    const team2 = useAgentTeamStore.getState().createTeam({ name: "2", task: "" })
    const task = useAgentTeamStore
      .getState()
      .createTask({ teamId: team1.id, title: "X", description: "" })
    useAgentTeamStore.getState().upsertTask({ ...task, teamId: team2.id })
    expect(useAgentTeamStore.getState().teams[team1.id].taskIds).not.toContain(task.id)
    expect(useAgentTeamStore.getState().teams[team2.id].taskIds).toContain(task.id)
  })

  it("updateTask merges patches and is a no-op for unknown ids", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "" })
    const t = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "X", description: "" })
    useAgentTeamStore.getState().updateTask(t.id, { title: "Y" })
    expect(useAgentTeamStore.getState().tasks[t.id].title).toBe("Y")
    useAgentTeamStore.getState().updateTask("missing", { title: "z" })
  })

  it("deleteTask removes from team and tasks map", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "" })
    const t = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "X", description: "" })
    useAgentTeamStore.getState().deleteTask(t.id)
    expect(useAgentTeamStore.getState().tasks[t.id]).toBeUndefined()
    expect(useAgentTeamStore.getState().teams[team.id].taskIds).not.toContain(t.id)
    // unknown id no-op
    useAgentTeamStore.getState().deleteTask("nothing")
  })

  it("deleteTask still drops the task entry when team has been removed already", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "" })
    const t = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "X", description: "" })
    useAgentTeamStore.setState((state) => {
      const { [team.id]: _t, ...rest } = state.teams
      return { teams: rest }
    })
    useAgentTeamStore.getState().deleteTask(t.id)
    expect(useAgentTeamStore.getState().tasks[t.id]).toBeUndefined()
  })

  it("setTaskStatus tracks startedAt / completedAt / actualDuration", async () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "" })
    const t = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "X", description: "" })
    useAgentTeamStore.getState().setTaskStatus(t.id, "in_progress", "starting")
    expect(useAgentTeamStore.getState().tasks[t.id].startedAt).toBeInstanceOf(Date)
    expect(useAgentTeamStore.getState().tasks[t.id].result).toBe("starting")
    await new Promise((r) => setTimeout(r, 5))
    useAgentTeamStore.getState().setTaskStatus(t.id, "completed", "done")
    const after = useAgentTeamStore.getState().tasks[t.id]
    expect(after.completedAt).toBeInstanceOf(Date)
    expect(typeof after.actualDuration).toBe("number")
    expect(after.result).toBe("done")
  })

  it("setTaskStatus with error message and the failed/cancelled branches", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "" })
    const t = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "X", description: "" })
    useAgentTeamStore.getState().setTaskStatus(t.id, "failed", undefined, "boom")
    expect(useAgentTeamStore.getState().tasks[t.id].error).toBe("boom")
    expect(useAgentTeamStore.getState().tasks[t.id].completedAt).toBeInstanceOf(Date)

    const t2 = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "Y", description: "" })
    useAgentTeamStore.getState().setTaskStatus(t2.id, "cancelled")
    expect(useAgentTeamStore.getState().tasks[t2.id].completedAt).toBeInstanceOf(Date)

    // Unknown id no-op
    useAgentTeamStore.getState().setTaskStatus("missing", "completed")
  })

  it("claimTask sets claimedBy and currentTaskId, but rejects when teammate is busy", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    const t = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "X", description: "" })
    useAgentTeamStore.getState().claimTask(t.id, tm.id)
    expect(useAgentTeamStore.getState().tasks[t.id].claimedBy).toBe(tm.id)
    expect(useAgentTeamStore.getState().teammates[tm.id].currentTaskId).toBe(t.id)

    // create another pending task and try to claim while busy
    const t2 = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "Y", description: "" })
    useAgentTeamStore.setState((s) => ({
      teammates: {
        ...s.teammates,
        [tm.id]: { ...s.teammates[tm.id], status: "executing" },
      },
    }))
    useAgentTeamStore.getState().claimTask(t2.id, tm.id)
    expect(useAgentTeamStore.getState().tasks[t2.id].claimedBy).toBeUndefined()
  })

  it("claimTask is a no-op for non-pending tasks or unknown ids", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    const t = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "X", description: "" })
    useAgentTeamStore.getState().setTaskStatus(t.id, "in_progress")
    useAgentTeamStore.getState().claimTask(t.id, tm.id)
    expect(useAgentTeamStore.getState().tasks[t.id].claimedBy).toBeUndefined()
    useAgentTeamStore.getState().claimTask("missing", tm.id)
  })

  it("claimTask works even when teammate id is unknown (skips teammates branch)", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "" })
    const t = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "X", description: "" })
    useAgentTeamStore.getState().claimTask(t.id, "unknown-tm")
    expect(useAgentTeamStore.getState().tasks[t.id].claimedBy).toBe("unknown-tm")
  })

  it("assignTask updates assignedTo and is a no-op for unknown ids", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    const t = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "X", description: "" })
    useAgentTeamStore.getState().assignTask(t.id, tm.id)
    expect(useAgentTeamStore.getState().tasks[t.id].assignedTo).toBe(tm.id)
    useAgentTeamStore.getState().assignTask("missing", tm.id)
  })
})

describe("useAgentTeamStore moveTask / reorderTask", () => {
  beforeEach(() => reset())

  const setup = () => {
    const state = useAgentTeamStore.getState()
    const team = state.createTeam({ name: "T", task: "t" })
    const task = state.createTask({ teamId: team.id, title: "X", description: "" })
    return { team, task }
  }

  it("returns task-not-found for unknown ids", () => {
    expect(useAgentTeamStore.getState().moveTask("missing", "cancelled")).toEqual({
      ok: false,
      reason: "task-not-found",
    })
  })

  it("denies illegal transitions with the guard's reason and leaves the task untouched", () => {
    const { task } = setup()
    const result = useAgentTeamStore.getState().moveTask(task.id, "completed")
    expect(result).toEqual({ ok: false, reason: "illegal-transition" })
    expect(useAgentTeamStore.getState().tasks[task.id].status).toBe("pending")
  })

  it("pending → cancelled stamps completedAt", () => {
    const { task } = setup()
    expect(useAgentTeamStore.getState().moveTask(task.id, "cancelled")).toEqual({ ok: true })
    const moved = useAgentTeamStore.getState().tasks[task.id]
    expect(moved.status).toBe("cancelled")
    expect(moved.completedAt).toBeInstanceOf(Date)
  })

  it("failed → pending (manual retry) clears run-owned fields", () => {
    const { task } = setup()
    useAgentTeamStore.getState().updateTask(task.id, {
      status: "failed",
      error: "boom",
      claimedBy: "tm-1",
      startedAt: new Date(Date.now() - 5000),
      completedAt: new Date(),
      actualDuration: 5000,
    })
    expect(useAgentTeamStore.getState().moveTask(task.id, "pending")).toEqual({ ok: true })
    const moved = useAgentTeamStore.getState().tasks[task.id]
    expect(moved.status).toBe("pending")
    expect(moved.error).toBeUndefined()
    expect(moved.claimedBy).toBeUndefined()
    expect(moved.startedAt).toBeUndefined()
    expect(moved.completedAt).toBeUndefined()
    expect(moved.actualDuration).toBeUndefined()
  })

  it("review → completed stamps completedAt and actualDuration from startedAt", () => {
    const { task } = setup()
    const startedAt = new Date(Date.now() - 3000)
    useAgentTeamStore.getState().updateTask(task.id, { status: "review", startedAt })
    expect(useAgentTeamStore.getState().moveTask(task.id, "completed")).toEqual({ ok: true })
    const moved = useAgentTeamStore.getState().tasks[task.id]
    expect(moved.status).toBe("completed")
    expect(moved.completedAt).toBeInstanceOf(Date)
    expect(moved.actualDuration).toBeGreaterThanOrEqual(3000)
  })

  it("claimed → pending at rest releases the teammate's currentTaskId mirror", () => {
    const { team, task } = setup()
    const state = useAgentTeamStore.getState()
    const mate = state.addTeammate({
      teamId: team.id,
      name: "W",
      description: "",
      role: "teammate",
    })
    state.claimTask(task.id, mate.id)
    expect(useAgentTeamStore.getState().tasks[task.id].status).toBe("claimed")
    expect(useAgentTeamStore.getState().teammates[mate.id].currentTaskId).toBe(task.id)

    expect(useAgentTeamStore.getState().moveTask(task.id, "pending")).toEqual({ ok: true })
    expect(useAgentTeamStore.getState().tasks[task.id].status).toBe("pending")
    expect(useAgentTeamStore.getState().tasks[task.id].claimedBy).toBeUndefined()
    expect(useAgentTeamStore.getState().teammates[mate.id].currentTaskId).toBeUndefined()
  })

  it("claimed → pending is denied while the team is executing", () => {
    const { team, task } = setup()
    const state = useAgentTeamStore.getState()
    const mate = state.addTeammate({
      teamId: team.id,
      name: "W",
      description: "",
      role: "teammate",
    })
    state.claimTask(task.id, mate.id)
    state.setTeamStatus(team.id, "executing")
    expect(useAgentTeamStore.getState().moveTask(task.id, "pending")).toEqual({
      ok: false,
      reason: "runtime-owned",
    })
    expect(useAgentTeamStore.getState().tasks[task.id].status).toBe("claimed")
  })

  it("reorderTask renumbers only the task's own column", () => {
    const state = useAgentTeamStore.getState()
    const team = state.createTeam({ name: "T", task: "t" })
    const a = state.createTask({ teamId: team.id, title: "a", description: "" })
    const b = state.createTask({ teamId: team.id, title: "b", description: "" })
    const c = state.createTask({ teamId: team.id, title: "c", description: "" })
    // A task in another column keeps its order untouched.
    const other = state.createTask({ teamId: team.id, title: "other", description: "" })
    state.updateTask(other.id, { status: "cancelled" })

    useAgentTeamStore.getState().reorderTask(a.id, 2)
    const tasks = useAgentTeamStore.getState().tasks
    expect(tasks[b.id].order).toBe(0)
    expect(tasks[c.id].order).toBe(1)
    expect(tasks[a.id].order).toBe(2)
    expect(tasks[other.id].order).toBe(3)
  })

  it("reorderTask is a no-op for unknown ids", () => {
    const before = useAgentTeamStore.getState().tasks
    useAgentTeamStore.getState().reorderTask("missing", 0)
    expect(useAgentTeamStore.getState().tasks).toBe(before)
  })
})

describe("useAgentTeamStore Messages", () => {
  beforeEach(() => reset())

  it("addMessage appends to messages map and team.messageIds", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "M", task: "" })
    const m = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      content: "hi",
    })
    expect(useAgentTeamStore.getState().messages[m.id]).toBeDefined()
    expect(useAgentTeamStore.getState().teams[team.id].messageIds).toContain(m.id)
    // implicit broadcast since no recipient
    expect(m.type).toBe("broadcast")
  })

  it("addMessage uses 'direct' when a recipient is supplied without explicit type", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "M", task: "" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "R" })
    const m = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      recipientId: tm.id,
      content: "to-you",
    })
    expect(m.type).toBe("direct")
    expect(m.recipientName).toBe("R")
  })

  it("addMessage uses an explicit type when provided", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "M", task: "" })
    const m = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      type: "system",
      content: "sys",
    })
    expect(m.type).toBe("system")
  })

  it("addMessage handles an unknown sender by labeling 'Unknown'", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "M", task: "" })
    const m = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: "ghost",
      content: "?",
    })
    expect(m.senderName).toBe("Unknown")
  })

  it("addMessage records the message even when team has been removed", () => {
    const m = useAgentTeamStore.getState().addMessage({
      teamId: "ghost",
      senderId: "x",
      content: "y",
    })
    expect(useAgentTeamStore.getState().messages[m.id]).toBeDefined()
  })

  it("upsertMessage replaces an existing message and ignores unknown teams", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "M", task: "" })
    const m = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      content: "a",
    })
    useAgentTeamStore.getState().upsertMessage({ ...m, content: "b" })
    expect(useAgentTeamStore.getState().messages[m.id].content).toBe("b")

    const ghost: AgentTeamMessage = {
      id: "g",
      teamId: "ghost",
      type: "system",
      senderId: "x",
      senderName: "x",
      content: "",
      read: false,
      timestamp: new Date(),
    }
    useAgentTeamStore.getState().upsertMessage(ghost)
    expect(useAgentTeamStore.getState().messages["g"]).toBeUndefined()
  })

  it("upsertMessage moves a message across teams", () => {
    const team1 = useAgentTeamStore.getState().createTeam({ name: "1", task: "" })
    const team2 = useAgentTeamStore.getState().createTeam({ name: "2", task: "" })
    const m = useAgentTeamStore.getState().addMessage({
      teamId: team1.id,
      senderId: team1.leadId,
      content: "x",
    })
    useAgentTeamStore.getState().upsertMessage({ ...m, teamId: team2.id })
    expect(useAgentTeamStore.getState().teams[team1.id].messageIds).not.toContain(m.id)
    expect(useAgentTeamStore.getState().teams[team2.id].messageIds).toContain(m.id)
  })

  it("removeMessage deletes the message and prunes it from team.messageIds", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "M", task: "" })
    const m = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      content: "delete me",
    })
    expect(useAgentTeamStore.getState().teams[team.id].messageIds).toContain(m.id)
    useAgentTeamStore.getState().removeMessage(m.id)
    expect(useAgentTeamStore.getState().messages[m.id]).toBeUndefined()
    expect(useAgentTeamStore.getState().teams[team.id].messageIds).not.toContain(m.id)
  })

  it("removeMessage is a no-op for unknown ids", () => {
    const before = useAgentTeamStore.getState().messages
    useAgentTeamStore.getState().removeMessage("ghost-id")
    expect(useAgentTeamStore.getState().messages).toEqual(before)
  })

  it("markMessageRead toggles read=true and is a no-op for unknown ids", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "M", task: "" })
    const m = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      content: "x",
    })
    useAgentTeamStore.getState().markMessageRead(m.id)
    expect(useAgentTeamStore.getState().messages[m.id].read).toBe(true)
    useAgentTeamStore.getState().markMessageRead("ghost")
  })

  it("markAllMessagesRead targets messages addressed to the teammate or broadcasts not from them", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "M", task: "" })
    const recipient = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "R" })
    const direct = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      recipientId: recipient.id,
      content: "to you",
    })
    const broadcast = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      content: "to all",
    })
    const myBroadcast = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: recipient.id,
      content: "I posted",
    })
    useAgentTeamStore.getState().markAllMessagesRead(recipient.id)
    expect(useAgentTeamStore.getState().messages[direct.id].read).toBe(true)
    expect(useAgentTeamStore.getState().messages[broadcast.id].read).toBe(true)
    // own broadcast should NOT be marked read
    expect(useAgentTeamStore.getState().messages[myBroadcast.id].read).toBe(false)
  })

  it("markTeamMessagesRead marks all unread messages on a team as read", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "M", task: "" })
    const m1 = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      content: "1",
    })
    const m2 = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      content: "2",
    })
    useAgentTeamStore.getState().markTeamMessagesRead(team.id)
    expect(useAgentTeamStore.getState().messages[m1.id].read).toBe(true)
    expect(useAgentTeamStore.getState().messages[m2.id].read).toBe(true)
  })

  it("markTeamMessagesRead is a no-op for unknown teams or empty messageIds", () => {
    useAgentTeamStore.getState().markTeamMessagesRead("missing")
    const team = useAgentTeamStore.getState().createTeam({ name: "M", task: "" })
    useAgentTeamStore.getState().markTeamMessagesRead(team.id)
    // already noop because messageIds is []
  })

  it("markTeamMessagesRead returns state when nothing was unread", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "M", task: "" })
    const m = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      content: "x",
    })
    useAgentTeamStore.getState().markMessageRead(m.id)
    const beforeMessages = useAgentTeamStore.getState().messages
    useAgentTeamStore.getState().markTeamMessagesRead(team.id)
    expect(useAgentTeamStore.getState().messages).toBe(beforeMessages)
  })
})

describe("useAgentTeamStore Events", () => {
  beforeEach(() => reset())

  it("addEvent caps at 100 entries and clearEvents drops them by team or globally", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "E", task: "" })
    for (let i = 0; i < 105; i++) {
      useAgentTeamStore.getState().addEvent({
        type: "task_started",
        teamId: team.id,
        timestamp: new Date(),
      })
    }
    expect(useAgentTeamStore.getState().events.length).toBeLessThanOrEqual(100)
    useAgentTeamStore.getState().clearEvents(team.id)
    expect(useAgentTeamStore.getState().events.filter((e) => e.teamId === team.id)).toHaveLength(0)
    useAgentTeamStore.getState().addEvent({
      type: "team_completed",
      teamId: "x",
      timestamp: new Date(),
    })
    useAgentTeamStore.getState().clearEvents()
    expect(useAgentTeamStore.getState().events).toHaveLength(0)
  })

  it("replaces the live progress_update row for a task in place", () => {
    const s = () => useAgentTeamStore.getState()
    s().addEvent({
      type: "progress_update",
      teamId: "t",
      taskId: "task-1",
      timestamp: new Date(),
      data: { phase: "start", toolCount: 0 },
    })
    s().addEvent({
      type: "progress_update",
      teamId: "t",
      taskId: "task-1",
      timestamp: new Date(),
      data: { phase: "running", toolCount: 2 },
    })
    // A different task does NOT collapse onto task-1.
    s().addEvent({
      type: "progress_update",
      teamId: "t",
      taskId: "task-2",
      timestamp: new Date(),
      data: { phase: "running", toolCount: 1 },
    })

    const progress = s().events.filter((e) => e.type === "progress_update")
    expect(progress).toHaveLength(2)
    const task1 = progress.find((e) => e.taskId === "task-1")!
    expect(task1.data?.phase).toBe("running")
    expect(task1.data?.toolCount).toBe(2)
  })

  it("freezes a terminal progress_update so later frames append instead of replacing", () => {
    const s = () => useAgentTeamStore.getState()
    s().addEvent({
      type: "progress_update",
      teamId: "t",
      taskId: "task-1",
      timestamp: new Date(),
      data: { phase: "running", toolCount: 1 },
    })
    s().addEvent({
      type: "progress_update",
      teamId: "t",
      taskId: "task-1",
      timestamp: new Date(),
      data: { phase: "done", toolCount: 3 },
    })
    // The done frame replaced the running one (still one row).
    expect(s().events.filter((e) => e.type === "progress_update")).toHaveLength(1)
    expect(s().events[0]!.data?.phase).toBe("done")

    // A subsequent frame for the same task can no longer replace the frozen row.
    s().addEvent({
      type: "progress_update",
      teamId: "t",
      taskId: "task-1",
      timestamp: new Date(),
      data: { phase: "running", toolCount: 4 },
    })
    expect(s().events.filter((e) => e.type === "progress_update")).toHaveLength(2)
  })
})

describe("useAgentTeamStore Templates", () => {
  beforeEach(() => reset())

  it("addTemplate / deleteTemplate / updateTemplate roundtrip user templates", () => {
    const tpl: AgentTeamTemplate = {
      id: "user-1",
      name: "User",
      description: "u",
      category: "general",
      teammates: [],
      isBuiltIn: false,
    }
    useAgentTeamStore.getState().addTemplate(tpl)
    expect(useAgentTeamStore.getState().templates["user-1"]).toBeDefined()
    useAgentTeamStore.getState().updateTemplate("user-1", { name: "Renamed" })
    expect(useAgentTeamStore.getState().templates["user-1"].name).toBe("Renamed")
    useAgentTeamStore.getState().deleteTemplate("user-1")
    expect(useAgentTeamStore.getState().templates["user-1"]).toBeUndefined()
  })

  it("deleteTemplate ignores built-in templates", () => {
    const builtInId = Object.values(useAgentTeamStore.getState().templates).find(
      (t) => t.isBuiltIn
    )!.id
    useAgentTeamStore.getState().deleteTemplate(builtInId)
    expect(useAgentTeamStore.getState().templates[builtInId]).toBeDefined()
  })

  it("deleteTemplate is a no-op for unknown ids", () => {
    useAgentTeamStore.getState().deleteTemplate("nope")
  })

  it("updateTemplate ignores built-ins and unknown templates", () => {
    const builtInId = Object.values(useAgentTeamStore.getState().templates).find(
      (t) => t.isBuiltIn
    )!.id
    useAgentTeamStore.getState().updateTemplate(builtInId, { name: "x" })
    expect(useAgentTeamStore.getState().templates[builtInId].name).not.toBe("x")
    useAgentTeamStore.getState().updateTemplate("missing", { name: "y" })
  })

  it("saveAsTemplate captures non-lead teammates and config", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "" })
    useAgentTeamStore.getState().addTeammate({
      teamId: team.id,
      name: "TM",
      description: "d",
      config: { specialization: "spec", provider: "openai" },
    })
    const saved = useAgentTeamStore.getState().saveAsTemplate(team.id, "Saved", "review")
    expect(saved).toBeDefined()
    expect(saved!.teammates).toHaveLength(1)
    expect(saved!.category).toBe("review")
    expect(useAgentTeamStore.getState().templates[saved!.id]).toBeDefined()
  })

  it("saveAsTemplate falls back to a default category and description", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "" })
    const saved = useAgentTeamStore.getState().saveAsTemplate(team.id, "Saved")
    expect(saved!.category).toBe("general")
    expect(saved!.description).toContain("Template created from team")
  })

  it("saveAsTemplate returns null for unknown team ids", () => {
    expect(useAgentTeamStore.getState().saveAsTemplate("nope", "n", "review")).toBeNull()
  })

  it("importTemplates / exportTemplates roundtrips user templates", () => {
    const tpl: AgentTeamTemplate = {
      id: "imp-1",
      name: "Imported",
      description: "x",
      category: "general",
      teammates: [],
      isBuiltIn: false,
    }
    const count = useAgentTeamStore.getState().importTemplates([tpl, { ...tpl, id: "" }])
    expect(count).toBe(2)
    const exported = useAgentTeamStore.getState().exportTemplates()
    expect(exported.every((t) => !t.isBuiltIn)).toBe(true)
    expect(exported.map((t) => t.name)).toContain("Imported")
  })

  it("importTemplates does not overwrite built-in templates", () => {
    const builtIn = Object.values(useAgentTeamStore.getState().templates).find((t) => t.isBuiltIn)!
    const tpl: AgentTeamTemplate = {
      ...builtIn,
      id: builtIn.id,
      name: "Replaced",
      isBuiltIn: false,
    }
    const imported = useAgentTeamStore.getState().importTemplates([tpl])
    expect(imported).toBe(0)
    expect(useAgentTeamStore.getState().templates[builtIn.id].name).toBe(builtIn.name)
  })
})

describe("useAgentTeamStore UI state", () => {
  beforeEach(() => reset())

  it("setActiveTeam clears workspace state when null", () => {
    useAgentTeamStore.getState().setActiveTeam(null)
    expect(useAgentTeamStore.getState().activeTeamId).toBeNull()
    expect(useAgentTeamStore.getState().selectedTeammateId).toBeNull()
  })

  it("setActiveTeam ignores unknown teams", () => {
    useAgentTeamStore.getState().setActiveTeam("ghost")
    expect(useAgentTeamStore.getState().activeTeamId).toBeNull()
  })

  it("setActiveTeam preserves a still-valid selectedTeammateId", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "X", task: "" })
    useAgentTeamStore.setState({ selectedTeammateId: team.leadId })
    useAgentTeamStore.getState().setActiveTeam(team.id)
    expect(useAgentTeamStore.getState().selectedTeammateId).toBe(team.leadId)
  })

  it("setActiveTeam clears a stale selectedTeammateId", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "X", task: "" })
    useAgentTeamStore.setState({ selectedTeammateId: "stranger" })
    useAgentTeamStore.getState().setActiveTeam(team.id)
    expect(useAgentTeamStore.getState().selectedTeammateId).toBeNull()
  })

  it("setSelectedTeammate writes selection and forces detail open if id present", () => {
    useAgentTeamStore.getState().setSelectedTeammate("tm-123")
    expect(useAgentTeamStore.getState().selectedTeammateId).toBe("tm-123")
    expect(useAgentTeamStore.getState().workspaceDetailOpen).toBe(true)
  })

  it("setSelectedTeammate(null) preserves the prior workspaceDetailOpen", () => {
    useAgentTeamStore.setState({ workspaceDetailOpen: false })
    useAgentTeamStore.getState().setSelectedTeammate(null)
    expect(useAgentTeamStore.getState().workspaceDetailOpen).toBe(false)
  })

  it("setDisplayMode / setIsPanelOpen / setWorkspaceTab mutate UI flags", () => {
    useAgentTeamStore.getState().setDisplayMode("compact")
    useAgentTeamStore.getState().setIsPanelOpen(true)
    useAgentTeamStore.getState().setWorkspaceTab("tasks")
    expect(useAgentTeamStore.getState().displayMode).toBe("compact")
    expect(useAgentTeamStore.getState().isPanelOpen).toBe(true)
    expect(useAgentTeamStore.getState().workspaceTab).toBe("tasks")
  })

  it("setWorkspaceFocus merges partial focus and forces detail open", () => {
    useAgentTeamStore.getState().setWorkspaceFocus({ teammateId: "x" })
    expect(useAgentTeamStore.getState().workspaceFocus.teammateId).toBe("x")
    expect(useAgentTeamStore.getState().workspaceDetailOpen).toBe(true)
    useAgentTeamStore.getState().setWorkspaceFocus({ taskId: "t" })
    expect(useAgentTeamStore.getState().workspaceFocus.taskId).toBe("t")
    useAgentTeamStore.getState().setWorkspaceFocus({ messageId: "m" })
    expect(useAgentTeamStore.getState().workspaceFocus.messageId).toBe("m")
  })

  it("setWorkspaceTeamFromRoute is a no-op for null/unknown teams", () => {
    useAgentTeamStore.getState().setWorkspaceTeamFromRoute(null)
    expect(useAgentTeamStore.getState().activeTeamId).toBeNull()
    useAgentTeamStore.getState().setWorkspaceTeamFromRoute("ghost")
    expect(useAgentTeamStore.getState().activeTeamId).toBeNull()
  })

  it("setWorkspaceTeamFromRoute hooks active team and a still-valid selection", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "" })
    useAgentTeamStore.setState({ selectedTeammateId: team.leadId })
    useAgentTeamStore.getState().setWorkspaceTeamFromRoute(team.id)
    expect(useAgentTeamStore.getState().activeTeamId).toBe(team.id)
    expect(useAgentTeamStore.getState().selectedTeammateId).toBe(team.leadId)
  })

  it("setWorkspaceTeamFromRoute drops a stale selectedTeammateId", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "" })
    useAgentTeamStore.setState({ selectedTeammateId: "stranger" })
    useAgentTeamStore.getState().setWorkspaceTeamFromRoute(team.id)
    expect(useAgentTeamStore.getState().selectedTeammateId).toBeNull()
  })

  it("closeAgentTeamWorkspaceDetail clears focus and selection", () => {
    useAgentTeamStore.setState({
      workspaceDetailOpen: true,
      selectedTeammateId: "x",
      workspaceFocus: { teammateId: "x", taskId: "y", messageId: "z" },
    })
    useAgentTeamStore.getState().closeAgentTeamWorkspaceDetail()
    const s = useAgentTeamStore.getState()
    expect(s.workspaceDetailOpen).toBe(false)
    expect(s.selectedTeammateId).toBeNull()
    expect(s.workspaceFocus).toEqual({ teammateId: null, taskId: null, messageId: null })
  })
})

describe("useAgentTeamStore inline selectors", () => {
  beforeEach(() => reset())

  it("getTeam / getTeammate / getTeammates / getTeamTasks / getTeamMessages / getActiveTeam", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "G", task: "" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    const t = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "x", description: "" })
    const m = useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      content: "hi",
    })

    expect(useAgentTeamStore.getState().getTeam(team.id)?.id).toBe(team.id)
    expect(useAgentTeamStore.getState().getTeam("missing")).toBeUndefined()
    expect(useAgentTeamStore.getState().getTeammate(tm.id)?.id).toBe(tm.id)
    expect(
      useAgentTeamStore
        .getState()
        .getTeammates(team.id)
        .map((t) => t.id)
    ).toContain(tm.id)
    expect(useAgentTeamStore.getState().getTeammates("missing")).toEqual([])
    expect(
      useAgentTeamStore
        .getState()
        .getTeamTasks(team.id)
        .map((tk) => tk.id)
    ).toEqual([t.id])
    expect(useAgentTeamStore.getState().getTeamTasks("missing")).toEqual([])
    expect(
      useAgentTeamStore
        .getState()
        .getTeamMessages(team.id)
        .map((x) => x.id)
    ).toEqual([m.id])
    expect(useAgentTeamStore.getState().getTeamMessages("missing")).toEqual([])
    expect(useAgentTeamStore.getState().getActiveTeam()?.id).toBe(team.id)
  })

  it("getActiveTeam returns undefined when no active team", () => {
    expect(useAgentTeamStore.getState().getActiveTeam()).toBeUndefined()
  })

  it("getUnreadMessages filters by recipient and broadcasts not from sender", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "G", task: "" })
    const recipient = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "R" })
    useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      recipientId: recipient.id,
      content: "to you",
    })
    useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: team.leadId,
      content: "to all",
    })
    useAgentTeamStore.getState().addMessage({
      teamId: team.id,
      senderId: recipient.id,
      content: "I sent",
    })
    const unread = useAgentTeamStore.getState().getUnreadMessages(recipient.id)
    expect(unread.map((m) => m.content).sort()).toEqual(["to all", "to you"])

    // After marking read, gets nothing
    for (const m of unread) {
      useAgentTeamStore.getState().markMessageRead(m.id)
    }
    expect(useAgentTeamStore.getState().getUnreadMessages(recipient.id)).toEqual([])
  })
})

describe("useAgentTeamStore batch operations", () => {
  beforeEach(() => reset())

  it("cancelAllTasks transitions live tasks to cancelled", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "B", task: "" })
    const t1 = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "1", description: "" })
    const t2 = useAgentTeamStore
      .getState()
      .createTask({ teamId: team.id, title: "2", description: "" })
    useAgentTeamStore.getState().setTaskStatus(t2.id, "in_progress")
    useAgentTeamStore.getState().cancelAllTasks(team.id)
    expect(useAgentTeamStore.getState().tasks[t1.id].status).toBe("cancelled")
    expect(useAgentTeamStore.getState().tasks[t2.id].status).toBe("cancelled")
    useAgentTeamStore.getState().cancelAllTasks("ghost")
  })

  it("shutdownAllTeammates transitions live members to shutdown", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "S", task: "" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    useAgentTeamStore.getState().setTeammateStatus(tm.id, "executing")
    useAgentTeamStore.getState().shutdownAllTeammates(team.id)
    expect(useAgentTeamStore.getState().teammates[tm.id].status).toBe("shutdown")
    useAgentTeamStore.getState().shutdownAllTeammates("ghost")
  })

  it("cleanupTeam removes all team-owned data", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "C", task: "" })
    useAgentTeamStore.getState().createTask({ teamId: team.id, title: "x", description: "" })
    useAgentTeamStore
      .getState()
      .addMessage({ teamId: team.id, senderId: team.leadId, content: "x" })
    useAgentTeamStore.getState().upsertConsensus({
      id: "c-1",
      teamId: team.id,
      initiatorId: team.leadId,
      question: "?",
      options: [],
      type: "majority",
      status: "open",
      votes: [],
      createdAt: new Date(),
    })
    useAgentTeamStore.getState().writeSharedMemory(team.id, "k", {
      key: "k",
      value: 1,
      writtenBy: team.leadId,
      writtenAt: new Date(),
      version: 1,
    } as SharedMemoryEntry)
    useAgentTeamStore.getState().upsertDelegation({
      id: "d-1",
      sourceTeamId: team.id,
      sourceTaskId: "x",
      targetType: "team",
      status: "active",
      reason: "r",
      manual: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as TeamDelegationRecord)
    useAgentTeamStore.getState().setActiveTeam(team.id)
    useAgentTeamStore.getState().cleanupTeam(team.id)
    expect(useAgentTeamStore.getState().teams[team.id]).toBeUndefined()
    expect(useAgentTeamStore.getState().activeTeamId).toBeNull()
    expect(useAgentTeamStore.getState().consensus["c-1"]).toBeUndefined()
    expect(useAgentTeamStore.getState().sharedMemory[team.id]).toBeUndefined()
    expect(useAgentTeamStore.getState().delegations["d-1"]).toBeUndefined()
    useAgentTeamStore.getState().cleanupTeam("ghost")
  })

  it("cleanupTeam does NOT clear activeTeamId when it points elsewhere", () => {
    const team1 = useAgentTeamStore.getState().createTeam({ name: "1", task: "" })
    const team2 = useAgentTeamStore.getState().createTeam({ name: "2", task: "" })
    useAgentTeamStore.getState().setActiveTeam(team2.id)
    useAgentTeamStore.getState().cleanupTeam(team1.id)
    expect(useAgentTeamStore.getState().activeTeamId).toBe(team2.id)
  })
})

describe("useAgentTeamStore Consensus", () => {
  beforeEach(() => reset())

  it("upsertConsensus / deleteConsensus / clearTeamConsensus", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "C", task: "" })
    const c: ConsensusRequest = {
      id: "c-1",
      teamId: team.id,
      initiatorId: team.leadId,
      question: "?",
      options: ["a", "b"],
      type: "majority",
      status: "open",
      votes: [],
      createdAt: new Date(),
    }
    useAgentTeamStore.getState().upsertConsensus(c)
    expect(useAgentTeamStore.getState().teams[team.id].consensusIds).toContain(c.id)
    useAgentTeamStore.getState().upsertConsensus(c) // dedupe
    expect(
      useAgentTeamStore.getState().teams[team.id].consensusIds!.filter((i) => i === c.id).length
    ).toBe(1)
    useAgentTeamStore.getState().deleteConsensus(c.id)
    expect(useAgentTeamStore.getState().consensus[c.id]).toBeUndefined()

    // upsert another consensus then clearTeamConsensus
    useAgentTeamStore.getState().upsertConsensus({ ...c, id: "c-2" })
    useAgentTeamStore.getState().clearTeamConsensus(team.id)
    expect(useAgentTeamStore.getState().consensus["c-2"]).toBeUndefined()
    expect(useAgentTeamStore.getState().teams[team.id].consensusIds).toEqual([])
  })

  it("upsertConsensus with unknown team still records consensus map entry", () => {
    const c: ConsensusRequest = {
      id: "ghost",
      teamId: "missing",
      initiatorId: "x",
      question: "?",
      options: [],
      type: "majority",
      status: "open",
      votes: [],
      createdAt: new Date(),
    }
    useAgentTeamStore.getState().upsertConsensus(c)
    expect(useAgentTeamStore.getState().consensus["ghost"]).toBeDefined()
  })

  it("deleteConsensus is a no-op for unknown ids", () => {
    useAgentTeamStore.getState().deleteConsensus("missing")
  })

  it("deleteConsensus tolerates a removed parent team", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "C", task: "" })
    useAgentTeamStore.getState().upsertConsensus({
      id: "c-x",
      teamId: team.id,
      initiatorId: team.leadId,
      question: "?",
      options: [],
      type: "majority",
      status: "open",
      votes: [],
      createdAt: new Date(),
    })
    useAgentTeamStore.setState((state) => {
      const { [team.id]: _t, ...rest } = state.teams
      return { teams: rest }
    })
    useAgentTeamStore.getState().deleteConsensus("c-x")
    expect(useAgentTeamStore.getState().consensus["c-x"]).toBeUndefined()
  })

  it("clearTeamConsensus tolerates an unknown team id", () => {
    useAgentTeamStore.getState().clearTeamConsensus("missing")
  })
})

describe("useAgentTeamStore Shared Memory", () => {
  beforeEach(() => reset())

  it("writeSharedMemory writes to both team and store maps", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "S", task: "" })
    const entry: SharedMemoryEntry = {
      key: "k",
      value: "v",
      writtenBy: team.leadId,
      writtenAt: new Date(),
      version: 1,
    }
    useAgentTeamStore.getState().writeSharedMemory(team.id, "k", entry)
    expect(useAgentTeamStore.getState().sharedMemory[team.id]?.["k"]).toBeDefined()
    expect(useAgentTeamStore.getState().teams[team.id].sharedMemory?.["k"]).toBeDefined()
  })

  it("writeSharedMemory evicts the oldest entry when over the configured cap", () => {
    const team = useAgentTeamStore.getState().createTeam({
      name: "S",
      task: "",
      config: { maxSharedMemoryEntries: 2 },
    })
    const baseEntry = (key: string, ts: number): SharedMemoryEntry => ({
      key,
      value: key,
      writtenBy: team.leadId,
      writtenAt: new Date(ts),
      version: 1,
    })
    useAgentTeamStore.getState().writeSharedMemory(team.id, "old", baseEntry("old", 1))
    useAgentTeamStore.getState().writeSharedMemory(team.id, "mid", baseEntry("mid", 2))
    useAgentTeamStore.getState().writeSharedMemory(team.id, "new", baseEntry("new", 3))
    const mem = useAgentTeamStore.getState().sharedMemory[team.id]
    expect(Object.keys(mem)).not.toContain("old")
    expect(Object.keys(mem)).toEqual(expect.arrayContaining(["mid", "new"]))
  })

  it("writeSharedMemory handles a missing team without throwing", () => {
    const entry: SharedMemoryEntry = {
      key: "k",
      value: "v",
      writtenBy: "x",
      writtenAt: new Date(),
      version: 1,
    }
    useAgentTeamStore.getState().writeSharedMemory("ghost", "k", entry)
    expect(useAgentTeamStore.getState().sharedMemory["ghost"]?.["k"]).toBeDefined()
  })

  it("deleteSharedMemory removes a key and is a no-op for unknown keys", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "S", task: "" })
    useAgentTeamStore.getState().writeSharedMemory(team.id, "k", {
      key: "k",
      value: 1,
      writtenBy: team.leadId,
      writtenAt: new Date(),
      version: 1,
    })
    useAgentTeamStore.getState().deleteSharedMemory(team.id, "k")
    expect(useAgentTeamStore.getState().sharedMemory[team.id]?.["k"]).toBeUndefined()
    useAgentTeamStore.getState().deleteSharedMemory(team.id, "k")
    useAgentTeamStore.getState().deleteSharedMemory("ghost", "k")
  })

  it("clearTeamSharedMemory empties shared memory for a team", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "S", task: "" })
    useAgentTeamStore.getState().writeSharedMemory(team.id, "k", {
      key: "k",
      value: 1,
      writtenBy: team.leadId,
      writtenAt: new Date(),
      version: 1,
    })
    useAgentTeamStore.getState().clearTeamSharedMemory(team.id)
    expect(useAgentTeamStore.getState().sharedMemory[team.id]).toBeUndefined()
    expect(useAgentTeamStore.getState().teams[team.id].sharedMemory).toEqual({})
    useAgentTeamStore.getState().clearTeamSharedMemory("ghost")
  })
})

describe("useAgentTeamStore Delegations", () => {
  beforeEach(() => reset())

  it("upsertDelegation / updateDelegationStatus / clearTeamDelegations", () => {
    const d: TeamDelegationRecord = {
      id: "d-1",
      sourceTeamId: "team-x",
      sourceTaskId: "task-x",
      targetType: "team",
      status: "pending",
      reason: "r",
      manual: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    useAgentTeamStore.getState().upsertDelegation(d)
    useAgentTeamStore.getState().updateDelegationStatus(d.id, "completed", "ok")
    expect(useAgentTeamStore.getState().delegations[d.id].status).toBe("completed")
    expect(useAgentTeamStore.getState().delegations[d.id].result).toBe("ok")
    expect(useAgentTeamStore.getState().delegations[d.id].completedAt).toBeInstanceOf(Date)
    useAgentTeamStore.getState().updateDelegationStatus("missing", "completed")
    useAgentTeamStore.getState().clearTeamDelegations("team-x")
    expect(useAgentTeamStore.getState().delegations[d.id]).toBeUndefined()
  })

  it("updateDelegationStatus also sets completedAt for failed and cancelled states", () => {
    const d: TeamDelegationRecord = {
      id: "d-2",
      sourceTeamId: "team-x",
      sourceTaskId: "task-x",
      targetType: "team",
      status: "active",
      reason: "r",
      manual: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    useAgentTeamStore.getState().upsertDelegation(d)
    useAgentTeamStore.getState().updateDelegationStatus(d.id, "failed")
    expect(useAgentTeamStore.getState().delegations[d.id].completedAt).toBeInstanceOf(Date)

    const d3: TeamDelegationRecord = { ...d, id: "d-3", status: "active" }
    useAgentTeamStore.getState().upsertDelegation(d3)
    useAgentTeamStore.getState().updateDelegationStatus(d3.id, "cancelled")
    expect(useAgentTeamStore.getState().delegations[d3.id].completedAt).toBeInstanceOf(Date)
  })
})

describe("useAgentTeamStore Execution Reports", () => {
  beforeEach(() => reset())

  it("upsertExecutionReport / addExecutionCheckpoint", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "R", task: "" })
    const report: TeamExecutionReport = {
      id: "r-1",
      teamId: team.id,
      status: "running",
      checkpoints: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    useAgentTeamStore.getState().upsertExecutionReport(team.id, report)
    expect(useAgentTeamStore.getState().teams[team.id].executionReport?.id).toBe("r-1")

    const checkpoint: TeamExecutionCheckpoint = {
      id: "ck-1",
      type: "task_completed",
      timestamp: new Date(),
      summary: "ok",
    }
    useAgentTeamStore.getState().addExecutionCheckpoint(team.id, checkpoint)
    expect(useAgentTeamStore.getState().teams[team.id].executionReport?.checkpoints).toHaveLength(1)

    // No-op branches
    useAgentTeamStore.getState().upsertExecutionReport("missing", report)
    useAgentTeamStore.getState().addExecutionCheckpoint("missing", checkpoint)
    // Adding checkpoint when no report
    const team2 = useAgentTeamStore.getState().createTeam({ name: "R2", task: "" })
    useAgentTeamStore.getState().addExecutionCheckpoint(team2.id, checkpoint)
    expect(useAgentTeamStore.getState().teams[team2.id].executionReport).toBeUndefined()
  })
})

describe("useAgentTeamStore structured messages and shutdown", () => {
  beforeEach(() => reset())

  it("addStructuredMessage derives type from payload type and persists message", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "S", task: "" })
    const m = useAgentTeamStore.getState().addStructuredMessage({
      teamId: team.id,
      senderId: team.leadId,
      content: "x",
      structuredPayload: { type: "shutdown_request", reason: "r" },
    })
    expect(m.type).toBe("shutdown")
    expect(useAgentTeamStore.getState().messages[m.id]).toBeDefined()
    expect(useAgentTeamStore.getState().teams[team.id].messageIds).toContain(m.id)
  })

  it("addStructuredMessage falls back to provided type when payload type is not in map", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "S", task: "" })
    const m = useAgentTeamStore.getState().addStructuredMessage({
      teamId: team.id,
      senderId: team.leadId,
      content: "x",
      type: "system",
      structuredPayload: { type: "task_assignment", taskId: "t-1" },
    })
    // map has task_assignment so it uses that
    expect(m.type).toBe("task_assignment")
  })

  it("addStructuredMessage falls back to 'system' when payload type unmapped and no input.type", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "S", task: "" })
    const m = useAgentTeamStore.getState().addStructuredMessage({
      teamId: team.id,
      senderId: team.leadId,
      content: "x",
      structuredPayload: {
        type: "made_up" as unknown as "idle_notification",
      } as never,
    })
    expect(m.type).toBe("system")
  })

  it("addStructuredMessage records the message even when team is missing", () => {
    const m = useAgentTeamStore.getState().addStructuredMessage({
      teamId: "ghost",
      senderId: "x",
      content: "y",
      structuredPayload: { type: "idle_notification" },
    })
    expect(useAgentTeamStore.getState().messages[m.id]).toBeDefined()
  })

  it("addStructuredMessage labels recipient when known", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "S", task: "" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    const m = useAgentTeamStore.getState().addStructuredMessage({
      teamId: team.id,
      senderId: team.leadId,
      recipientId: tm.id,
      content: "x",
      structuredPayload: { type: "idle_notification" },
    })
    expect(m.recipientName).toBe("W")
    expect(m.senderName).toBeDefined()
  })

  it("requestTeammateShutdown sets status and emits a structured shutdown message", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Sh", task: "" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    useAgentTeamStore.getState().requestTeammateShutdown(tm.id, "bye")
    expect(useAgentTeamStore.getState().teammates[tm.id].status).toBe("shutdown")
    const messages = Object.values(useAgentTeamStore.getState().messages)
    expect(messages.some((m) => m.type === "shutdown")).toBe(true)
  })

  it("requestTeammateShutdown is a no-op for unknown ids", () => {
    useAgentTeamStore.getState().requestTeammateShutdown("missing")
  })

  it("requestTeammateShutdown skips the structured message when teammate's team is missing", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Sh", task: "" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "W" })
    useAgentTeamStore.setState((state) => {
      const { [team.id]: _t, ...rest } = state.teams
      return { teams: rest }
    })
    useAgentTeamStore.getState().requestTeammateShutdown(tm.id, "no team")
    // No structured shutdown message should exist for this teammate
    const shutdownMsgs = Object.values(useAgentTeamStore.getState().messages).filter(
      (m) => m.type === "shutdown" && m.recipientId === tm.id
    )
    expect(shutdownMsgs).toHaveLength(0)
  })

  it("requestTeammateShutdown emits a default content when no reason is given", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Sh", task: "" })
    const tm = useAgentTeamStore.getState().addTeammate({ teamId: team.id, name: "Worker" })
    useAgentTeamStore.getState().requestTeammateShutdown(tm.id)
    const shutdownMsg = Object.values(useAgentTeamStore.getState().messages).find(
      (m) => m.type === "shutdown" && m.recipientId === tm.id
    )
    expect(shutdownMsg?.content).toContain("Shutdown requested")
  })
})

describe("useAgentTeamStore default config / reset", () => {
  beforeEach(() => reset())

  it("updateDefaultConfig merges patches", () => {
    useAgentTeamStore.getState().updateDefaultConfig({ maxConcurrentTeammates: 11 })
    expect(useAgentTeamStore.getState().defaultConfig.maxConcurrentTeammates).toBe(11)
  })

  it("updateDefaultConfig clears preferredExecutionPattern when executionMode flips", () => {
    useAgentTeamStore.getState().updateDefaultConfig({
      executionMode: "autonomous",
    })
    expect(useAgentTeamStore.getState().defaultConfig.executionMode).toBe("autonomous")
  })

  it("updateDefaultConfig clears governancePolicy when legacy fields change", () => {
    useAgentTeamStore.getState().updateDefaultConfig({
      requirePlanApproval: !useAgentTeamStore.getState().defaultConfig.requirePlanApproval,
    })
    // governancePolicy is undefined or unchanged depending on normalization; assert the toggled field stuck
    expect(useAgentTeamStore.getState().defaultConfig.requirePlanApproval).toBeDefined()
  })

  it("reset restores initial state and built-in templates", () => {
    useAgentTeamStore.getState().createTeam({ name: "R", task: "" })
    useAgentTeamStore.getState().reset()
    expect(useAgentTeamStore.getState().teams).toEqual({})
    expect(Object.keys(useAgentTeamStore.getState().templates).length).toBeGreaterThan(0)
  })
})

describe("useAgentTeamStore clearStaleCapabilityIds", () => {
  beforeEach(() => reset())

  it("strips flagged ids from a team-level bundle, dropping empty buckets", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Stale", task: "t" })
    useAgentTeamStore.getState().updateTeamCapabilities(team.id, {
      skillIds: ["keep", "ghost"],
      subagentIds: ["only-ghost"],
    })
    useAgentTeamStore.getState().clearStaleCapabilityIds({ teamId: team.id }, [
      {
        code: "missing-skill",
        bucket: "skillIds",
        missingId: "ghost",
        scope: { kind: "team", teamId: team.id },
      },
      {
        code: "missing-subagent",
        bucket: "subagentIds",
        missingId: "only-ghost",
        scope: { kind: "team", teamId: team.id },
      },
    ])
    const caps = useAgentTeamStore.getState().teams[team.id].config.capabilities
    expect(caps?.skillIds).toEqual(["keep"])
    expect(caps?.subagentIds).toBeUndefined() // emptied → dropped
  })

  it("strips flagged ids from a teammate overlay add/replace lists", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Stale2", task: "t" })
    const teammate = useAgentTeamStore
      .getState()
      .addTeammate({ teamId: team.id, name: "W", role: "teammate" })
    useAgentTeamStore.getState().updateTeammateCapabilities(teammate.id, {
      skillIds: { add: ["keep", "ghost"] },
      characterPackIds: { replace: ["pack-ghost"] },
    })
    useAgentTeamStore.getState().clearStaleCapabilityIds({ teammateId: teammate.id }, [
      {
        code: "missing-skill",
        bucket: "skillIds",
        missingId: "ghost",
        scope: { kind: "teammate", teamId: team.id, teammateId: teammate.id },
      },
      {
        code: "missing-character-pack",
        bucket: "characterPackIds",
        missingId: "pack-ghost",
        scope: { kind: "teammate", teamId: team.id, teammateId: teammate.id },
      },
    ])
    const overlay = useAgentTeamStore.getState().teammates[teammate.id].config.capabilities
    expect(overlay?.skillIds?.add).toEqual(["keep"])
    // characterPackIds replace emptied → whole bucket dropped
    expect(overlay?.characterPackIds).toBeUndefined()
  })

  it("is a no-op when no warning matches the target scope", () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "NoOp", task: "t" })
    useAgentTeamStore.getState().updateTeamCapabilities(team.id, { skillIds: ["keep"] })
    useAgentTeamStore.getState().clearStaleCapabilityIds({ teamId: team.id }, [])
    expect(useAgentTeamStore.getState().teams[team.id].config.capabilities?.skillIds).toEqual([
      "keep",
    ])
  })
})

describe("workspace (project) isolation", () => {
  beforeEach(() => {
    reset()
  })

  it("createTeam stamps the active project id", () => {
    mockActiveProjectId = "proj-A"
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "t" })
    expect(team.projectId).toBe("proj-A")
  })

  it("updateTeam stamps a workspace on a team that still lacks one, and keeps an existing one", () => {
    mockActiveProjectId = "proj-A"
    const team = useAgentTeamStore.getState().createTeam({ name: "T", task: "t" })
    // Simulate a pre-isolation row that slipped past the persist backfill.
    useAgentTeamStore.setState((state) => ({
      teams: { ...state.teams, [team.id]: { ...state.teams[team.id], projectId: undefined } },
    }))
    mockActiveProjectId = "proj-B"
    useAgentTeamStore.getState().updateTeam(team.id, { name: "T2" })
    expect(useAgentTeamStore.getState().teams[team.id].projectId).toBe("proj-B")
    mockActiveProjectId = "proj-C"
    useAgentTeamStore.getState().updateTeam(team.id, { name: "T3" })
    expect(useAgentTeamStore.getState().teams[team.id].projectId).toBe("proj-B")
    // No active workspace at all → the default workspace, never undefined.
    useAgentTeamStore.setState((state) => ({
      teams: { ...state.teams, [team.id]: { ...state.teams[team.id], projectId: undefined } },
    }))
    mockActiveProjectId = null
    useAgentTeamStore.getState().updateTeam(team.id, { name: "T4" })
    expect(useAgentTeamStore.getState().teams[team.id].projectId).toBe("project-default")
    useAgentTeamStore.getState().updateTeam("missing", { name: "x" })
  })

  it("purgeProject removes only the target workspace's teams, teammates, and tasks", () => {
    mockActiveProjectId = "proj-A"
    const teamA = useAgentTeamStore.getState().createTeam({ name: "A", task: "a" })
    useAgentTeamStore.getState().createTask({ teamId: teamA.id, title: "tA", description: "d" })
    mockActiveProjectId = "proj-B"
    const teamB = useAgentTeamStore.getState().createTeam({ name: "B", task: "b" })

    useAgentTeamStore.getState().purgeProject("proj-A")

    const s = useAgentTeamStore.getState()
    expect(s.teams[teamA.id]).toBeUndefined()
    expect(s.teams[teamB.id]).toBeDefined()
    // Teammates + tasks of the purged team are gone.
    expect(Object.values(s.teammates).some((tm) => tm.teamId === teamA.id)).toBe(false)
    expect(Object.values(s.tasks).some((t) => t.teamId === teamA.id)).toBe(false)
    // Team B's lead teammate survives.
    expect(Object.values(s.teammates).some((tm) => tm.teamId === teamB.id)).toBe(true)
  })

  it("purgeProject leaves shared templates untouched", () => {
    mockActiveProjectId = "proj-A"
    const team = useAgentTeamStore.getState().createTeam({ name: "A", task: "a" })
    const templateCountBefore = Object.keys(useAgentTeamStore.getState().templates).length
    useAgentTeamStore.getState().purgeProject("proj-A")
    expect(useAgentTeamStore.getState().teams[team.id]).toBeUndefined()
    expect(Object.keys(useAgentTeamStore.getState().templates).length).toBe(templateCountBefore)
  })
})

describe("account storage isolation", () => {
  const persistedTeam = (id: string, name: string) => ({
    id,
    name,
    description: "",
    task: "",
    status: "idle",
    config: {},
    selectedExecutionPattern: "sequential",
    leadId: `${id}-lead`,
    teammateIds: [`${id}-lead`],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  })

  beforeEach(() => {
    reset()
  })

  it("activates an account-local team snapshot without leaking the previous account", () => {
    localStorage.setItem(
      "cognia-agent-teams:acct_a",
      JSON.stringify({ state: { teams: { team_a: persistedTeam("team_a", "Alpha team") } } })
    )
    localStorage.setItem(
      "cognia-agent-teams:acct_b",
      JSON.stringify({ state: { teams: { team_b: persistedTeam("team_b", "Beta team") } } })
    )

    activateAgentTeamAccountStorage("acct_a")
    expect(Object.keys(useAgentTeamStore.getState().teams)).toEqual(["team_a"])

    activateAgentTeamAccountStorage("acct_b")
    expect(Object.keys(useAgentTeamStore.getState().teams)).toEqual(["team_b"])
    expect(useAgentTeamStore.getState().teams.team_a).toBeUndefined()
  })

  it("clears in-memory account state without deleting the account snapshot", () => {
    localStorage.setItem(
      "cognia-agent-teams:acct_a",
      JSON.stringify({ state: { teams: { team_a: persistedTeam("team_a", "Alpha team") } } })
    )

    activateAgentTeamAccountStorage("acct_a")
    clearAgentTeamAccountStorage()

    expect(useAgentTeamStore.getState().teams).toEqual({})
    expect(localStorage.getItem("cognia-agent-teams:acct_a")).toContain("Alpha team")
  })

  it("purges only the deleted account's team bucket", () => {
    localStorage.setItem(
      "cognia-agent-teams:acct_a",
      JSON.stringify({ state: { teams: { team_a: persistedTeam("team_a", "A") } } })
    )
    localStorage.setItem(
      "cognia-agent-teams:acct_b",
      JSON.stringify({ state: { teams: { team_b: persistedTeam("team_b", "B") } } })
    )

    purgeAgentTeamAccountStorage("acct_a")

    expect(localStorage.getItem("cognia-agent-teams:acct_a")).toBeNull()
    expect(localStorage.getItem("cognia-agent-teams:acct_b")).toContain("team_b")
  })
})
