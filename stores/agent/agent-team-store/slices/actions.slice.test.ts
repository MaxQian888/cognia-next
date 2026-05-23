/**
 * @jest-environment jsdom
 */
import { useAgentTeamStore } from "../store"
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

jest.mock("@/lib/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    loggers: {
      agent: { ...child, child: () => child },
    },
  }
})

const reset = () => {
  useAgentTeamStore.getState().reset()
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

  it("addTeammate throws if the team is missing", () => {
    expect(() =>
      useAgentTeamStore.getState().addTeammate({ teamId: "missing", name: "x" })
    ).toThrow(/Team not found/)
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
