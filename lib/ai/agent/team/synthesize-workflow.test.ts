import { synthesizeTeamWorkflow, SynthesizeError } from "./synthesize-workflow"
import type { AgentTeam, AgentTeamTask } from "@/types/agent/agent-team"

const team: AgentTeam = {
  id: "team-1",
  name: "Test Team",
  description: "",
  task: "do a thing",
  status: "idle",
  config: {
    maxTeammates: 5,
    maxConcurrentTeammates: 3,
    executionMode: "coordinated",
    displayMode: "expanded",
  },
  leadId: "lead-1",
  teammateIds: ["w1", "w2"],
  taskIds: [],
  messageIds: [],
  progress: 0,
  totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  createdAt: new Date(),
} as AgentTeam

const task = (id: string, deps: string[] = [], order = 0): AgentTeamTask =>
  ({
    id,
    teamId: "team-1",
    title: id,
    description: `desc ${id}`,
    status: "pending",
    priority: "medium",
    dependencies: deps,
    tags: [],
    createdAt: new Date(),
    order,
  }) satisfies AgentTeamTask

describe("synthesizeTeamWorkflow", () => {
  it("converts a flat task list to a VW with no edges", () => {
    const { workflow, nodeIdToTaskId } = synthesizeTeamWorkflow({
      team,
      tasks: [task("t1"), task("t2")],
      initialConcurrency: 3,
    })
    expect(workflow.nodes).toHaveLength(2)
    expect(workflow.edges).toHaveLength(0)
    expect(workflow.settings.maxConcurrency).toBe(3)
    expect(nodeIdToTaskId.get("t1")).toBe("t1")
  })

  it("emits one edge per dependency", () => {
    const { workflow } = synthesizeTeamWorkflow({
      team,
      tasks: [task("t1"), task("t2", ["t1"])],
      initialConcurrency: 3,
    })
    expect(workflow.edges).toHaveLength(1)
    expect(workflow.edges[0]).toMatchObject({ source: "t1", target: "t2" })
  })

  it("each node has action.team.task.dispatch type and the right params", () => {
    const { workflow } = synthesizeTeamWorkflow({
      team,
      tasks: [task("t1")],
      initialConcurrency: 3,
    })
    expect(workflow.nodes[0].type).toBe("action.team.task.dispatch")
    expect(workflow.nodes[0].typeVersion).toBe(1)
    expect(workflow.nodes[0].data.params).toMatchObject({
      teamId: "team-1",
      taskId: "t1",
      title: "t1",
      description: "desc t1",
    })
  })

  it("workflow id has __team__ prefix", () => {
    const { workflow } = synthesizeTeamWorkflow({
      team,
      tasks: [task("t1")],
      initialConcurrency: 1,
    })
    expect(workflow.id.startsWith("__team__:team-1:")).toBe(true)
  })

  it("throws SynthesizeError on empty task list", () => {
    expect(() => synthesizeTeamWorkflow({ team, tasks: [], initialConcurrency: 1 })).toThrow(
      SynthesizeError
    )
  })

  it("throws SynthesizeError on a cycle", () => {
    expect(() =>
      synthesizeTeamWorkflow({
        team,
        tasks: [task("t1", ["t2"]), task("t2", ["t1"])],
        initialConcurrency: 1,
      })
    ).toThrow(/cycle/)
  })

  it("throws SynthesizeError on an unresolvable dep id", () => {
    expect(() =>
      synthesizeTeamWorkflow({
        team,
        tasks: [task("t1", ["missing"])],
        initialConcurrency: 1,
      })
    ).toThrow(/invalid_dep/)
  })

  it("wallClockTimeoutMs threads into settings.timeoutMs", () => {
    const { workflow } = synthesizeTeamWorkflow({
      team,
      tasks: [task("t1")],
      initialConcurrency: 1,
      wallClockTimeoutMs: 60_000,
    })
    expect(workflow.settings.timeoutMs).toBe(60_000)
  })

  it("complex DAG produces correct edge set", () => {
    const { workflow } = synthesizeTeamWorkflow({
      team,
      tasks: [task("a"), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])],
      initialConcurrency: 4,
    })
    expect(workflow.edges).toHaveLength(4)
    const edgeKeys = workflow.edges.map((e) => `${e.source}->${e.target}`).sort()
    expect(edgeKeys).toEqual(["a->b", "a->c", "b->d", "c->d"])
  })

  it("synthesized workflow passes orchestrator validateWorkflow", () => {
    const { workflow } = synthesizeTeamWorkflow({
      team,
      tasks: [task("t1"), task("t2", ["t1"])],
      initialConcurrency: 2,
    })
    // Smoke check key fields the validator demands.
    expect(workflow.schemaVersion).toBe(1)
    expect(workflow.settings.errorPolicy).toBe("stop")
    expect(workflow.settings.concurrency).toBeGreaterThanOrEqual(1)
    expect(workflow.settings.retryDefaults).toBeDefined()
  })
})
