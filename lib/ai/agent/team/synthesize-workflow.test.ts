import {
  classifyTeamTaskAccess,
  synthesizeTeamWorkflow,
  SynthesizeError,
  resolveRetryPolicy,
} from "./synthesize-workflow"
import { DEFAULT_RETRY_POLICY } from "@/types/workflow/visual"
import type { AgentTeam, AgentTeamConfig, AgentTeamTask } from "@/types/agent/agent-team"

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
    priority: "normal",
    dependencies: deps,
    tags: [],
    createdAt: new Date(),
    order,
  }) satisfies AgentTeamTask

const reviewTeam = (maxRevisions?: number): AgentTeam =>
  ({
    ...team,
    config: {
      ...team.config,
      taskReview: { enabled: true, ...(maxRevisions === undefined ? {} : { maxRevisions }) },
    },
  }) as AgentTeam

describe("synthesizeTeamWorkflow — durable task routing", () => {
  it("classifies explicit and tagged read-only work without serializing it as a writer", () => {
    expect(classifyTeamTaskAccess({ ...task("research"), tags: ["Research"] })).toBe("read")
    expect(
      classifyTeamTaskAccess({
        ...task("explicit"),
        metadata: { access: "read" },
      })
    ).toBe("read")
    expect(classifyTeamTaskAccess(task("code"))).toBe("write")
  })

  it("projects repository ownership and forces integration review in isolated parallel mode", () => {
    const isolated = {
      ...team,
      config: { ...team.config, runtimeVersion: "durable-v2", writeMode: "isolated-parallel" },
    } as AgentTeam
    const routed = {
      ...task("code"),
      tags: ["ui"],
      metadata: { repositoryId: "dependency", fileOwnership: ["src/feature"] },
    }

    const { workflow } = synthesizeTeamWorkflow({
      team: isolated,
      tasks: [routed],
      initialConcurrency: 2,
    })

    expect(workflow.nodes.find((node) => node.id === "code")?.data.params).toMatchObject({
      access: "write",
      taskKind: "ui",
      repositoryId: "dependency",
      fileOwnership: ["src/feature"],
    })
    expect(workflow.nodes.some((node) => node.id === "review:code")).toBe(true)
  })
})

describe("synthesizeTeamWorkflow — blocking lead review (ADR-0071)", () => {
  it("emits no review nodes when review is off", () => {
    const { workflow } = synthesizeTeamWorkflow({
      team,
      tasks: [task("t1")],
      initialConcurrency: 3,
    })
    expect(workflow.nodes.map((n) => n.type)).toEqual(["action.team.task.dispatch"])
  })

  it("emits one review node per task, guarding its dispatch", () => {
    const { workflow } = synthesizeTeamWorkflow({
      team: reviewTeam(),
      tasks: [task("t1")],
      initialConcurrency: 3,
    })

    const review = workflow.nodes.find((n) => n.type === "action.team.task.review")
    expect(review?.id).toBe("review:t1")
    expect(review?.data.params).toMatchObject({
      teamId: "team-1",
      taskId: "t1",
      title: "t1",
      dispatchNodeId: "t1",
      maxRevisions: 2,
    })
    // The dispatch must finish before its review runs.
    expect(workflow.edges).toContainEqual(
      expect.objectContaining({ source: "t1", target: "review:t1" })
    )
  })

  it("bakes an explicit revision budget into the node", () => {
    const { workflow } = synthesizeTeamWorkflow({
      team: reviewTeam(0),
      tasks: [task("t1")],
      initialConcurrency: 3,
    })
    const review = workflow.nodes.find((n) => n.type === "action.team.task.review")
    expect(review?.data.params).toMatchObject({ maxRevisions: 0 })
  })

  it("blocks a dependent on the review, not on the raw dispatch", () => {
    // The whole point: t2 must not start until t1's work is approved.
    const { workflow } = synthesizeTeamWorkflow({
      team: reviewTeam(),
      tasks: [task("t1"), task("t2", ["t1"])],
      initialConcurrency: 3,
    })

    expect(workflow.edges).toContainEqual(
      expect.objectContaining({ source: "review:t1", target: "t2" })
    )
    expect(workflow.edges).not.toContainEqual(
      expect.objectContaining({ source: "t1", target: "t2" })
    )
  })

  it("keeps the dependency in the dependent's params so it still reads the blackboard", () => {
    const { workflow } = synthesizeTeamWorkflow({
      team: reviewTeam(),
      tasks: [task("t1"), task("t2", ["t1"])],
      initialConcurrency: 3,
    })
    const t2 = workflow.nodes.find((n) => n.id === "t2")
    // Params carry TASK ids (blackboard keys), never node ids.
    expect(t2?.data.params).toMatchObject({ dependencies: ["t1"] })
  })

  it("does not review a dependency satisfied outside this workflow", () => {
    // A prior wave already ran (and reviewed) it; there is no dispatch node here
    // to hang a review off, and re-reviewing it would re-run its worker.
    const { workflow } = synthesizeTeamWorkflow({
      team: reviewTeam(),
      tasks: [task("t2", ["t0"])],
      initialConcurrency: 3,
      satisfiedDependencyIds: new Set(["t0"]),
    })

    expect(workflow.nodes.map((n) => n.id).sort()).toEqual(["review:t2", "t2"])
    expect(workflow.edges).toEqual([expect.objectContaining({ source: "t2", target: "review:t2" })])
  })

  it("still detects a cycle across the review indirection", () => {
    expect(() =>
      synthesizeTeamWorkflow({
        team: reviewTeam(),
        tasks: [task("t1", ["t2"]), task("t2", ["t1"])],
        initialConcurrency: 3,
      })
    ).toThrow(SynthesizeError)
  })

  it("maps review nodes back to their task", () => {
    const { nodeIdToTaskId } = synthesizeTeamWorkflow({
      team: reviewTeam(),
      tasks: [task("t1")],
      initialConcurrency: 3,
    })
    expect(nodeIdToTaskId.get("review:t1")).toBe("t1")
    expect(nodeIdToTaskId.get("t1")).toBe("t1")
  })
})

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

  it("threads a task's assignedTo into the node params (skill-aware claim)", () => {
    const assigned = { ...task("t1"), assignedTo: "w2" } as AgentTeamTask
    const { workflow } = synthesizeTeamWorkflow({ team, tasks: [assigned], initialConcurrency: 3 })
    expect(workflow.nodes[0].data.params).toMatchObject({ taskId: "t1", assignedTo: "w2" })
  })

  it("threads task dependencies into the node params (blackboard read seam)", () => {
    const { workflow } = synthesizeTeamWorkflow({
      team,
      tasks: [task("t1"), task("t2", ["t1"])],
      initialConcurrency: 3,
    })
    const t2 = workflow.nodes.find((n) => n.id === "t2")!
    expect(t2.data.params).toMatchObject({ taskId: "t2", dependencies: ["t1"] })
    // Root tasks carry no dependencies key.
    const t1 = workflow.nodes.find((n) => n.id === "t1")!
    expect(t1.data.params).not.toHaveProperty("dependencies")
  })

  it("omits assignedTo from params when the task is unassigned", () => {
    const { workflow } = synthesizeTeamWorkflow({
      team,
      tasks: [task("t1")],
      initialConcurrency: 3,
    })
    expect(workflow.nodes[0].data.params).not.toHaveProperty("assignedTo")
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

  it("threads team.config.maxRetries into settings.retryDefaults.attempts", () => {
    const retryTeam = { ...team, config: { ...team.config, maxRetries: 4 } } as AgentTeam
    const { workflow } = synthesizeTeamWorkflow({
      team: retryTeam,
      tasks: [task("t1")],
      initialConcurrency: 1,
    })
    // attempts = maxRetries + 1 (initial try + retries)
    expect(workflow.settings.retryDefaults?.attempts).toBe(5)
  })

  it("collapses retryDefaults to a single attempt when enableTaskRetry is false", () => {
    const noRetryTeam = {
      ...team,
      config: { ...team.config, maxRetries: 4, enableTaskRetry: false },
    } as AgentTeam
    const { workflow } = synthesizeTeamWorkflow({
      team: noRetryTeam,
      tasks: [task("t1")],
      initialConcurrency: 1,
    })
    expect(workflow.settings.retryDefaults?.attempts).toBe(1)
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

  describe("resolveRetryPolicy", () => {
    const cfg = (over: Partial<AgentTeamConfig> = {}): AgentTeamConfig => ({
      maxTeammates: 5,
      maxConcurrentTeammates: 3,
      executionMode: "coordinated",
      displayMode: "expanded",
      ...over,
    })

    it("defaults to DEFAULT_RETRY_POLICY when no retry config is set", () => {
      expect(resolveRetryPolicy(cfg())).toEqual(DEFAULT_RETRY_POLICY)
    })

    it("is null-safe when the whole config is undefined", () => {
      expect(resolveRetryPolicy(undefined)).toEqual(DEFAULT_RETRY_POLICY)
    })

    it("maps maxRetries=0 to a single attempt (no retry)", () => {
      expect(resolveRetryPolicy(cfg({ maxRetries: 0 })).attempts).toBe(1)
    })

    it("maps maxRetries=N to N+1 attempts", () => {
      expect(resolveRetryPolicy(cfg({ maxRetries: 5 })).attempts).toBe(6)
    })

    it("forces a single attempt when enableTaskRetry is false, ignoring maxRetries", () => {
      expect(resolveRetryPolicy(cfg({ maxRetries: 5, enableTaskRetry: false })).attempts).toBe(1)
    })

    it("keeps enableTaskRetry=true honoring maxRetries", () => {
      expect(resolveRetryPolicy(cfg({ maxRetries: 2, enableTaskRetry: true })).attempts).toBe(3)
    })

    it("preserves backoff shape from DEFAULT_RETRY_POLICY", () => {
      const p = resolveRetryPolicy(cfg({ maxRetries: 1 }))
      expect(p.backoff).toBe(DEFAULT_RETRY_POLICY.backoff)
      expect(p.baseMs).toBe(DEFAULT_RETRY_POLICY.baseMs)
      expect(p.maxMs).toBe(DEFAULT_RETRY_POLICY.maxMs)
    })
  })

  describe("satisfiedDependencyIds (wave subsets)", () => {
    it("accepts a dep satisfied outside the workflow without an edge", () => {
      const { workflow } = synthesizeTeamWorkflow({
        team,
        tasks: [task("t2", ["t1"])],
        initialConcurrency: 1,
        satisfiedDependencyIds: new Set(["t1"]),
      })
      // No edge to the external dep, but it stays in params for blackboard reads.
      expect(workflow.edges).toHaveLength(0)
      const params = workflow.nodes[0]!.data.params as { dependencies?: string[] }
      expect(params.dependencies).toEqual(["t1"])
    })

    it("still validates deps that are neither intra nor satisfied", () => {
      expect(() =>
        synthesizeTeamWorkflow({
          team,
          tasks: [task("t2", ["t1", "ghost"])],
          initialConcurrency: 1,
          satisfiedDependencyIds: new Set(["t1"]),
        })
      ).toThrow(/invalid_dep/)
    })

    it("a single ready wave (no intra deps) produces zero edges", () => {
      const { workflow } = synthesizeTeamWorkflow({
        team,
        tasks: [task("a", ["x"]), task("b", ["x"])],
        initialConcurrency: 2,
        satisfiedDependencyIds: new Set(["x"]),
      })
      expect(workflow.edges).toHaveLength(0)
      expect(workflow.nodes).toHaveLength(2)
    })

    it("mixes intra edges with external satisfied deps", () => {
      const { workflow } = synthesizeTeamWorkflow({
        team,
        // b depends on a (intra) AND prior (external)
        tasks: [task("a"), task("b", ["a", "prior"])],
        initialConcurrency: 2,
        satisfiedDependencyIds: new Set(["prior"]),
      })
      expect(workflow.edges.map((e) => `${e.source}->${e.target}`)).toEqual(["a->b"])
    })
  })
})
