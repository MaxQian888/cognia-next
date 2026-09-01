/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import {
  agentTeamFromRow,
  agentTeamTaskFromRow,
  agentTeamTaskToRow,
  agentTeamToRow,
  agentTeammateFromRow,
  agentTeammateToRow,
  deleteAgentTeamsForWorkspace,
  listAgentTeamsByWorkspace,
  loadAgentTeamDefinitions,
  writeAgentTeamDefinitions,
} from "./agent-team-definitions"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"

function team(over: Partial<AgentTeam> = {}): AgentTeam {
  return {
    id: "team_a",
    projectId: "ws_1",
    name: "Alpha",
    description: "",
    task: "ship it",
    status: "idle",
    config: {},
    leadId: "mate_a",
    teammateIds: ["mate_a"],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(1_000),
    ...over,
  } as AgentTeam
}

function teammate(over: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id: "mate_a",
    teamId: "team_a",
    name: "Lead",
    description: "",
    role: "lead",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(2_000),
    ...over,
  } as AgentTeammate
}

function task(over: Partial<AgentTeamTask> = {}): AgentTeamTask {
  return {
    id: "task_a",
    teamId: "team_a",
    title: "Do the thing",
    description: "",
    status: "pending",
    priority: "medium",
    order: 0,
    createdAt: new Date(3_000),
    ...over,
  } as AgentTeamTask
}

describe("row conversion", () => {
  it("round-trips a squad through the row shape", () => {
    const source = team()
    expect(agentTeamFromRow(agentTeamToRow(source, 9))).toEqual(source)
  })

  /**
   * `dispatchDecision` and `externalPickup` are additive optional fields that
   * older squads simply lack. The conversion must not drop them from the ones
   * that have them, which was the point the persist-shape test used to make
   * before these rows moved out of localStorage.
   */
  it("carries the additive optional fields across", () => {
    const source = team({
      dispatchDecision: { kind: "external-handoff", confidence: 0.6 } as never,
      externalPickup: { state: "waiting" } as never,
    })
    const back = agentTeamFromRow(agentTeamToRow(source, 9))
    expect(back.dispatchDecision).toEqual(source.dispatchDecision)
    expect(back.externalPickup).toEqual(source.externalPickup)
  })

  it("round-trips a teammate and a task", () => {
    expect(agentTeammateFromRow(agentTeammateToRow(teammate(), 9))).toEqual(teammate())
    expect(agentTeamTaskFromRow(agentTeamTaskToRow(task(), 9))).toEqual(task())
  })

  /** Sync reads a cursor off this, and the domain types never had one. */
  it("stamps updatedAt on the row without leaking it back into the domain type", () => {
    const row = agentTeamToRow(team(), 4_242)
    expect(row.updatedAt).toBe(4_242)
    expect(agentTeamFromRow(row)).not.toHaveProperty("updatedAt")
  })

  /** Backup and transport turn a Date into an ISO string on the way through. */
  it("accepts a date that came back as a string", () => {
    const row = agentTeamToRow(team({ createdAt: "1970-01-01T00:00:01.000Z" as never }), 1)
    expect(row.createdAt).toBe(1_000)
  })
})

describe("stored definitions", () => {
  beforeEach(async () => {
    await writeAgentTeamDefinitions({
      teams: [],
      teammates: [],
      tasks: [],
      deleteTeamIds: ["team_a", "team_b"],
      deleteTeammateIds: ["mate_a"],
      deleteTaskIds: ["task_a"],
    })
  })

  it("writes and reads the three tables together", async () => {
    await writeAgentTeamDefinitions({
      teams: [team()],
      teammates: [teammate()],
      tasks: [task()],
      now: 5,
    })
    const stored = await loadAgentTeamDefinitions()
    expect(stored.teams).toHaveLength(1)
    expect(stored.teammates).toHaveLength(1)
    expect(stored.tasks).toHaveLength(1)
    expect(stored.teams[0]?.createdAt).toBeInstanceOf(Date)
  })

  /**
   * A squad written before the column, or one deliberately left unscoped, is
   * legacy rather than foreign. Dropping it here would make squads vanish the
   * moment the filter landed.
   */
  it("includes an unscoped squad in every workspace", async () => {
    await writeAgentTeamDefinitions({
      teams: [team(), team({ id: "team_b", projectId: undefined })],
      teammates: [],
      tasks: [],
      now: 5,
    })
    const ids = (await listAgentTeamsByWorkspace("ws_2")).map((t) => t.id)
    expect(ids).toEqual(["team_b"])
    expect((await listAgentTeamsByWorkspace("ws_1")).map((t) => t.id).sort()).toEqual([
      "team_a",
      "team_b",
    ])
  })

  it("takes the roster and tasks with a workspace's squads", async () => {
    await writeAgentTeamDefinitions({
      teams: [team()],
      teammates: [teammate()],
      tasks: [task()],
      now: 5,
    })
    expect(await deleteAgentTeamsForWorkspace("ws_1")).toBe(1)
    const stored = await loadAgentTeamDefinitions()
    expect(stored.teams).toEqual([])
    expect(stored.teammates).toEqual([])
    expect(stored.tasks).toEqual([])
  })
})
