import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AgentTeam, AgentTeamConfig } from "@/types/agent/agent-team"
import { createDurableTeamCoordinator } from "./durable-runtime"

const config = (overrides: Partial<AgentTeamConfig> = {}): AgentTeamConfig => ({
  maxTeammates: 3,
  maxConcurrentTeammates: 2,
  executionMode: "coordinated",
  displayMode: "expanded",
  runtimeVersion: "durable-v2",
  writeMode: "single-writer",
  repositories: [
    { id: "primary", role: "primary", path: "/repo", writable: true },
    { id: "dep", role: "dependency", path: "/dep", writable: true },
  ],
  resourcePolicy: { priority: 2, maxConcurrentChildren: 2 },
  ...overrides,
})

const team = (overrides: Partial<AgentTeam> = {}): AgentTeam =>
  ({
    id: "team-1",
    projectId: "project-1",
    name: "Team",
    description: "",
    task: "Ship",
    status: "idle",
    config: config(),
    leadId: "lead-1",
    teammateIds: ["lead-1", "mate-1"],
    taskIds: ["task-1"],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(1),
    ...overrides,
  }) as AgentTeam

describe("durable AgentTeam coordinator", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("rejects ambiguous repository topology before creating a run", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 100 })
    const invalid = team({
      config: config({
        repositories: [
          { id: "one", role: "primary", path: "/one", writable: true },
          { id: "two", role: "primary", path: "/two", writable: true },
        ],
      }),
    })

    await expect(coordinator.prepareRun(invalid, "run-invalid")).rejects.toThrow(
      /exactly one primary repository/
    )
    expect(await getDb().agentTeamRuns.count()).toBe(0)
  })

  it("snapshots configured operator constraints into the immutable run ledger", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 90 })
    await coordinator.prepareRun(
      team({
        config: config({
          userConstraints: [{ title: "Compatibility", detail: "Do not break the public API" }],
        }),
      }),
      "run-constraints"
    )

    const decisions = await getDb()
      .agentTeamDecisions.where("runId")
      .equals("run-constraints")
      .toArray()
    expect(decisions).toEqual([
      expect.objectContaining({
        status: "constraint",
        immutable: true,
        title: "Compatibility",
        detail: "Do not break the public API",
      }),
    ])
  })

  it("serializes writers while allowing read-only work to proceed", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 100 })
    await coordinator.prepareRun(team(), "run-1")
    const order: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = coordinator.withWorkspaceLease(
      { runId: "run-1", repositoryId: "primary", access: "write" },
      async () => {
        order.push("writer-1:start")
        await firstBlocked
        order.push("writer-1:end")
      }
    )
    const second = coordinator.withWorkspaceLease(
      { runId: "run-1", repositoryId: "primary", access: "write" },
      async () => order.push("writer-2")
    )
    const reader = coordinator.withWorkspaceLease(
      { runId: "run-1", repositoryId: "primary", access: "read" },
      async () => order.push("reader")
    )

    await reader
    expect(order).toEqual(["writer-1:start", "reader"])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(["writer-1:start", "reader", "writer-1:end", "writer-2"])
  })

  it("delivers live steering and queues a durable fallback when live control fails", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 200 })
    await coordinator.prepareRun(team(), "run-2")
    await coordinator.registerChild({
      runId: "run-2",
      childRunId: "child-1",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "write",
    })
    const steer = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-1", { steer })

    const delivered = await coordinator.steer("child-1", "Check tests")
    expect(delivered.status).toBe("delivered")
    expect(steer).toHaveBeenCalledWith("Check tests", delivered.id)

    coordinator.attachLiveControl("child-1", {
      steer: async () => {
        throw new Error("no active turn")
      },
    })
    const queued = await coordinator.steer("child-1", "Inspect migration")
    expect(queued.status).toBe("queued")
    expect(await getDb().agentTeamSteeringReceipts.where("status").equals("queued").count()).toBe(1)
  })

  it("sends the PII-gated steering payload to the live runtime", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 225 })
    await coordinator.prepareRun(team(), "run-redacted-steer")
    await coordinator.registerChild({
      runId: "run-redacted-steer",
      childRunId: "child-redacted-steer",
      teammateId: "mate-1",
      taskId: "task-redacted-steer",
      repositoryId: "primary",
      access: "read",
    })
    const steer = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-redacted-steer", { steer })

    const receipt = await coordinator.steer(
      "child-redacted-steer",
      "Contact operator@example.com before continuing"
    )

    expect(receipt.message).not.toContain("operator@example.com")
    expect(steer).toHaveBeenCalledWith(receipt.message, receipt.id)
  })

  it("forwards pause, resume, and terminate requests to the active provider control", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 250 })
    await coordinator.prepareRun(team(), "run-control")
    await coordinator.registerChild({
      runId: "run-control",
      childRunId: "child-control",
      teammateId: "mate-1",
      taskId: "task-control",
      repositoryId: "primary",
      access: "write",
    })
    const pause = jest.fn(async () => undefined)
    const resume = jest.fn(async () => undefined)
    const terminate = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-control", {
      steer: async () => undefined,
      pause,
      resume,
      terminate,
    })

    await coordinator.pauseChild("child-control")
    await coordinator.resumeChild("child-control")
    await coordinator.terminateChild("child-control")

    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect((await getDb().agentTeamChildRuns.get("child-control"))?.status).toBe("terminated")
  })

  it("recovers safe checkpoints and gates uncertain side effects", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 300 })
    await coordinator.prepareRun(team(), "run-safe")
    await coordinator.registerChild({
      runId: "run-safe",
      childRunId: "child-safe",
      teammateId: "mate-1",
      taskId: "task-safe",
      repositoryId: "primary",
      access: "write",
    })
    await coordinator.checkpoint("child-safe", {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: 0,
    })

    await coordinator.prepareRun(team(), "run-uncertain")
    await coordinator.registerChild({
      runId: "run-uncertain",
      childRunId: "child-uncertain",
      teammateId: "mate-1",
      taskId: "task-uncertain",
      repositoryId: "primary",
      access: "write",
    })
    await coordinator.checkpoint("child-uncertain", {
      replay: "needs_input",
      trajectorySequence: 0,
      sideEffects: [{ id: "publish", kind: "github_pr", state: "unknown", replay: "unknown" }],
    })

    const recovered = await coordinator.recover()
    expect(recovered).toEqual(
      expect.arrayContaining([
        { runId: "run-safe", status: "recovering" },
        { runId: "run-uncertain", status: "needs_input" },
      ])
    )
  })
})
