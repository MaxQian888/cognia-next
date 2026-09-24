import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AgentTeam, AgentTeamConfig } from "@/types/agent/agent-team"
import { createDurableTeamCoordinator } from "./durable-runtime"
import * as runtimeDb from "@/lib/db/agent-team-runtime"

// Keep real Dexie behavior while exposing configurable exports for race injection.
jest.mock("@/lib/db/agent-team-runtime", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/db/agent-team-runtime"),
}))

const removeManagedFleetSession = jest.fn<Promise<boolean>, [sessionId: string]>(async () => true)
jest.mock("@/lib/fleet/managed-session-projection", () => ({
  removeManagedFleetSession: (sessionId: string) => removeManagedFleetSession(sessionId),
}))

const config = (overrides: Partial<AgentTeamConfig> = {}): AgentTeamConfig => ({
  maxTeammates: 3,
  maxConcurrentTeammates: 2,
  executionMode: "coordinated",
  displayMode: "expanded",
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
    jest.restoreAllMocks()
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  const register = async (
    coordinator: ReturnType<typeof createDurableTeamCoordinator>,
    childRunId: string
  ) =>
    coordinator.registerChild({
      runId: "run-admission",
      childRunId,
      teammateId: childRunId,
      taskId: childRunId,
      repositoryId: "primary",
      access: "read",
    })

  const waitUntil = async (ready: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (ready()) return
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    throw new Error("Condition did not settle")
  }

  it("keeps terminal children terminal during recovery even without checkpoints", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team(), "run-admission")
    for (const status of ["completed", "failed", "cancelled", "terminated"] as const) {
      await register(coordinator, status)
      await runtimeDb.updateAgentTeamChildRun(status, { status })
    }
    const recovered = await coordinator.recover()
    expect(recovered).toEqual([{ runId: "run-admission", status: "recovering" }])
    for (const status of ["completed", "failed", "cancelled", "terminated"] as const) {
      expect((await runtimeDb.getAgentTeamChildRun(status))?.status).toBe(status)
    }
  })

  it("gates remote events persisted after the latest safe checkpoint", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team(), "run-admission")
    await register(coordinator, "remote")
    await coordinator.checkpoint("remote", {
      trajectorySequence: 1,
      replay: "safe",
      sideEffects: [],
    })
    await runtimeDb.appendAgentTeamTrajectory({
      runId: "run-admission",
      childRunId: "remote",
      kind: "remote_event",
      correlationId: "event-after-checkpoint",
      createdAt: Date.now(),
    })
    expect(await coordinator.recover()).toEqual([{ runId: "run-admission", status: "needs_input" }])
    expect((await runtimeDb.getAgentTeamChildRun("remote"))?.status).toBe("needs_input")
  })

  it("does not recover a run terminated after the recovery scan", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team(), "run-admission")
    await register(coordinator, "child")
    const list = runtimeDb.listAgentTeamRecoveryCandidates
    jest.spyOn(runtimeDb, "listAgentTeamRecoveryCandidates").mockImplementationOnce(async () => {
      const candidates = await list()
      await runtimeDb.updateAgentTeamRun("run-admission", { status: "terminated" })
      return candidates
    })
    expect(await coordinator.recover()).toEqual([])
    expect((await runtimeDb.getAgentTeamRun("run-admission"))?.status).toBe("terminated")
    expect((await runtimeDb.getAgentTeamChildRun("child"))?.status).toBe("running")
  })

  it("does not replace a terminated run with the budget input gate", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(
      team({
        config: config({
          resourcePolicy: { priority: 0, maxConcurrentChildren: 1, maxTokens: 0 },
        }),
      }),
      "run-admission"
    )
    await register(coordinator, "child")
    const getRun = runtimeDb.getAgentTeamRun
    jest.spyOn(runtimeDb, "getAgentTeamRun").mockImplementationOnce(async (id) => {
      const run = await getRun(id)
      await runtimeDb.updateAgentTeamRun(id, { status: "terminated" })
      return run
    })
    const operation = jest.fn()
    await expect(coordinator.withChildAdmission("child", operation)).rejects.toThrow("budget")
    expect((await runtimeDb.getAgentTeamRun("run-admission"))?.status).toBe("terminated")
    expect((await runtimeDb.getAgentTeamChildRun("child"))?.status).toBe("running")
    expect(operation).not.toHaveBeenCalled()
    expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
  })

  it("does not start a queued run cancelled while preparation reads it", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team(), "run-admission")
    await runtimeDb.updateAgentTeamRun("run-admission", { status: "queued" })
    const getRun = runtimeDb.getAgentTeamRun
    jest.spyOn(runtimeDb, "getAgentTeamRun").mockImplementationOnce(async (id) => {
      const run = await getRun(id)
      await runtimeDb.updateAgentTeamRun(id, { status: "cancelled" })
      return run
    })
    await expect(coordinator.prepareRun(team(), "run-admission")).rejects.toThrow("changed")
    expect((await runtimeDb.getAgentTeamRun("run-admission"))?.status).toBe("cancelled")
  })

  it.each(["completed", "failed", "cancelled", "terminated"] as const)(
    "does not revive a %s child through sleep or wake",
    async (status) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(team(), "run-admission")
      await register(coordinator, "child")
      await runtimeDb.updateAgentTeamChildRun("child", { status })
      const resume = jest.fn(async () => undefined)
      coordinator.attachLiveControl("child", { steer: jest.fn(), resume })
      await coordinator.sleepChild("child")
      await coordinator.wakeChild("child")
      expect((await runtimeDb.getAgentTeamChildRun("child"))?.status).toBe(status)
      expect(resume).not.toHaveBeenCalled()
    }
  )

  it("does not revive a child that terminates while wake waits for the provider", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team(), "run-admission")
    await register(coordinator, "child")
    await coordinator.sleepChild("child")
    coordinator.attachLiveControl("child", {
      steer: jest.fn(),
      resume: async () => {
        await runtimeDb.updateAgentTeamChildRun("child", { status: "terminated" })
      },
    })
    await coordinator.wakeChild("child")
    expect((await runtimeDb.getAgentTeamChildRun("child"))?.status).toBe("terminated")
  })

  it("rejects remote resume and cross-host migration after uncheckpointed remote work", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team(), "run-admission")
    await register(coordinator, "child")
    await runtimeDb.updateAgentTeamChildRun("child", {
      hostRef: "device:a",
      remoteSessionId: "remote-session",
      status: "paused",
    })
    await coordinator.checkpoint("child", {
      trajectorySequence: 1,
      replay: "safe",
      sideEffects: [],
    })
    await runtimeDb.appendAgentTeamTrajectory({
      runId: "run-admission",
      childRunId: "child",
      kind: "remote_event",
      correlationId: "uncheckpointed-command",
      createdAt: Date.now(),
    })
    await expect(coordinator.resumeChild("child")).rejects.toThrow("safe checkpoint")
    await expect(coordinator.retryChild("child", "device:b")).rejects.toThrow("safe checkpoint")
    expect((await runtimeDb.getAgentTeamChildRun("child"))?.status).toBe("paused")
  })

  it.each(["completed", "failed", "cancelled", "terminated"] as const)(
    "refuses child retry for a %s parent",
    async (status) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(team(), "run-admission")
      await register(coordinator, "child")
      await runtimeDb.updateAgentTeamChildRun("child", { status: "failed" })
      await runtimeDb.updateAgentTeamRun("run-admission", { status })
      await expect(coordinator.retryChild("child")).rejects.toThrow("cannot be retried")
      expect((await runtimeDb.getAgentTeamRun("run-admission"))?.status).toBe(status)
    }
  )

  it("rejects duplicate admission for the same child while the first holds capacity", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team(), "run-admission")
    await register(coordinator, "first")
    let release!: () => void
    const first = coordinator.withChildAdmission(
      "first",
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await waitUntil(() => !!release)
    await expect(coordinator.withChildAdmission("first", jest.fn())).rejects.toThrow(
      "already has an admission"
    )
    expect(coordinator.schedulerSnapshot().active).toHaveLength(1)
    release()
    await first
  })

  it("cancels admission parked on a paused run", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team(), "run-admission")
    await register(coordinator, "first")
    coordinator.setRunPaused("run-admission", true)
    const controller = new AbortController()
    const operation = jest.fn()
    const waiting = coordinator.withChildAdmission("first", operation, controller.signal)
    const rejected = expect(waiting).rejects.toThrow("cancel parked")
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort(new Error("cancel parked"))
    await rejected
    coordinator.setRunPaused("run-admission", false)
    expect(operation).not.toHaveBeenCalled()
    expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
  })

  it.each(["terminateChild", "pauseChild"] as const)(
    "does not execute queued work after %s",
    async (action) => {
      const coordinator = createDurableTeamCoordinator({ globalConcurrency: 1 })
      await coordinator.prepareRun(team(), "run-admission")
      await register(coordinator, "first")
      await register(coordinator, "second")
      let release!: () => void
      const first = coordinator.withChildAdmission(
        "first",
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
      await waitUntil(() => !!release)
      const operation = jest.fn()
      const second = coordinator.withChildAdmission("second", operation)
      const rejected = expect(second).rejects.toThrow()
      await waitUntil(() => coordinator.schedulerSnapshot().queued.length === 1)
      await coordinator[action]("second")
      release()
      await first
      await rejected
      expect(operation).not.toHaveBeenCalled()
      expect((await runtimeDb.getAgentTeamChildRun("second"))?.status).toBe(
        action === "terminateChild" ? "terminated" : "paused"
      )
      expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
    }
  )

  it("releases admission when the running-state write fails", async () => {
    const coordinator = createDurableTeamCoordinator({ globalConcurrency: 1 })
    await coordinator.prepareRun(team(), "run-admission")
    await register(coordinator, "first")
    const failRunning = (patch: Record<string, unknown>) => {
      if (patch.status === "running") throw new Error("injected DB failure")
    }
    getDb().agentTeamChildRuns.hook("updating", failRunning)
    await expect(coordinator.withChildAdmission("first", jest.fn())).rejects.toThrow(
      "injected DB failure"
    )
    getDb().agentTeamChildRuns.hook("updating").unsubscribe(failRunning)
    expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
  })

  it("cancels queued admission without waiting for the active child", async () => {
    const coordinator = createDurableTeamCoordinator({ globalConcurrency: 1 })
    await coordinator.prepareRun(team(), "run-admission")
    await register(coordinator, "first")
    await register(coordinator, "second")
    let release!: () => void
    const first = coordinator.withChildAdmission(
      "first",
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await waitUntil(() => !!release)
    const controller = new AbortController()
    const second = coordinator.withChildAdmission("second", jest.fn(), controller.signal)
    const rejected = expect(second).rejects.toThrow("cancel queued")
    await waitUntil(() => coordinator.schedulerSnapshot().queued.length === 1)
    controller.abort(new Error("cancel queued"))
    await rejected
    expect(coordinator.schedulerSnapshot().queued).toHaveLength(0)
    release()
    await first
  })

  it("retains active capacity until cancelled work settles and rejects its late result", async () => {
    const coordinator = createDurableTeamCoordinator({ globalConcurrency: 1 })
    await coordinator.prepareRun(team(), "run-admission")
    await register(coordinator, "first")
    await register(coordinator, "second")
    let release!: () => void
    const controller = new AbortController()
    const first = coordinator.withChildAdmission(
      "first",
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("late success")
        }),
      controller.signal
    )
    const rejected = expect(first).rejects.toThrow("cancel active")
    await waitUntil(() => !!release)
    controller.abort(new Error("cancel active"))
    const operation = jest.fn()
    const second = coordinator.withChildAdmission("second", operation)
    await waitUntil(() => coordinator.schedulerSnapshot().queued.length === 1)
    expect(coordinator.schedulerSnapshot().active).toHaveLength(1)
    expect(operation).not.toHaveBeenCalled()
    release()
    await Promise.all([rejected, second])
    expect(operation).toHaveBeenCalledTimes(1)
    expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
  })

  it("cancels a writer wait without releasing the preceding writer lease", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team(), "run-admission")
    const request = { runId: "run-admission", repositoryId: "primary", access: "write" as const }
    let release!: () => void
    const first = coordinator.withWorkspaceLease(
      request,
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await waitUntil(() => !!release)
    const controller = new AbortController()
    const skipped = jest.fn()
    const second = coordinator.withWorkspaceLease(request, skipped, controller.signal)
    const rejected = expect(second).rejects.toThrow("cancel writer")
    const thirdOperation = jest.fn()
    const third = coordinator.withWorkspaceLease(request, thirdOperation)
    controller.abort(new Error("cancel writer"))
    await rejected
    expect(skipped).not.toHaveBeenCalled()
    expect(thirdOperation).not.toHaveBeenCalled()
    release()
    await Promise.all([first, third])
    expect(thirdOperation).toHaveBeenCalledTimes(1)
  })

  it.each(["mutation", "alias", "root"])(
    "keeps isolated writer ownership exclusive across %s",
    async (scenario) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(
        team({ config: config({ writeMode: "isolated-parallel" }) }),
        "run-admission"
      )
      const ownership = [
        scenario === "alias" ? "src/../shared" : scenario === "root" ? "." : "shared",
      ]
      const request = {
        runId: "run-admission",
        repositoryId: "primary",
        access: "write" as const,
        fileOwnership: ownership,
      }
      let release!: () => void
      const active = coordinator.withWorkspaceLease(
        request,
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
      await waitUntil(() => !!release)
      if (scenario === "mutation") ownership[0] = "unrelated"
      const operation = jest.fn()
      try {
        await expect(
          coordinator.withWorkspaceLease(
            { ...request, fileOwnership: ["shared/file.ts"] },
            operation
          )
        ).rejects.toThrow("overlaps")
        expect(operation).not.toHaveBeenCalled()
      } finally {
        release()
        await active
      }
      await coordinator.withWorkspaceLease(
        { ...request, fileOwnership: ["shared/file.ts"] },
        operation
      )
      expect(operation).toHaveBeenCalledTimes(1)
    }
  )

  it("coalesces concurrent wake requests into one provider resume", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team(), "run-admission")
    await register(coordinator, "child")
    await coordinator.sleepChild("child")
    let release!: () => void
    const resumed = new Promise<void>((resolve) => {
      release = resolve
    })
    const resume = jest.fn(() => resumed)
    coordinator.attachLiveControl("child", { steer: jest.fn(), resume })
    const first = coordinator.wakeChild("child")
    const second = coordinator.wakeChild("child")
    await waitUntil(() => resume.mock.calls.length > 0)
    release()
    await Promise.all([first, second])
    expect(resume).toHaveBeenCalledTimes(1)
    await coordinator.wakeChild("child")
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it.each(["", "../outside", "/outside", "C:relative", "src\0file"])(
    "rejects invalid isolated ownership %s before execution",
    async (path) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(
        team({ config: config({ writeMode: "isolated-parallel" }) }),
        "run-admission"
      )
      const operation = jest.fn()
      await expect(
        coordinator.withWorkspaceLease(
          {
            runId: "run-admission",
            repositoryId: "primary",
            access: "write",
            fileOwnership: [path],
          },
          operation
        )
      ).rejects.toThrow(/ownership/)
      expect(operation).not.toHaveBeenCalled()
    }
  )

  it("reuses the remote checkpoint gate when waking a sleeping child", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team(), "run-admission")
    await register(coordinator, "child")
    await coordinator.sleepChild("child")
    await runtimeDb.updateAgentTeamChildRun("child", { remoteSessionId: "remote" })
    const resume = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child", { steer: jest.fn(), resume })
    await expect(coordinator.wakeChild("child")).rejects.toThrow("safe checkpoint")
    expect(resume).not.toHaveBeenCalled()
    expect(await runtimeDb.getAgentTeamChildRun("child")).toMatchObject({ status: "sleeping" })
    await coordinator.checkpoint("child", {
      replay: "safe",
      sideEffects: [],
      trajectorySequence: 1,
    })
    await coordinator.wakeChild("child")
    expect(await runtimeDb.getAgentTeamChildRun("child")).toMatchObject({ status: "queued" })
  })

  it("does not wake a sleeping child after its parent terminates", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team(), "run-admission")
    await register(coordinator, "child")
    await coordinator.sleepChild("child")
    await runtimeDb.updateAgentTeamRun("run-admission", { status: "terminated" })
    const resume = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child", { steer: jest.fn(), resume })
    await expect(coordinator.wakeChild("child")).rejects.toThrow("run stopped")
    expect(resume).not.toHaveBeenCalled()
  })

  it("keeps a newer pause when a concurrent wake finishes later", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team(), "run-admission")
    await register(coordinator, "child")
    await coordinator.sleepChild("child")
    let release!: () => void
    coordinator.attachLiveControl("child", {
      steer: jest.fn(),
      resume: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      pause: async () => true,
    })
    const wake = coordinator.wakeChild("child")
    await waitUntil(() => !!release)
    await coordinator.pauseChild("child")
    release()
    await wake
    expect(await runtimeDb.getAgentTeamChildRun("child")).toMatchObject({ status: "paused" })
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
    // Addressed the way `agent-team-bridge` addresses it. Keying the row on the
    // bare run id made this path create a SECOND execution row for the same
    // run (`sourceId: <teamId>` rather than `<runId>`), which nothing deduped.
    expect(await getDb().executionRuns.get("run-constraints")).toBeUndefined()
    expect(await getDb().executionRuns.get("execution:team:run-constraints")).toMatchObject({
      kind: "team",
      sourceId: "run-constraints",
      status: "running",
    })
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
    await getDb().agentTeamChildRuns.update("child-control", {
      remoteSessionId: "remote-control",
    })
    await coordinator.terminateChild("child-control")

    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(removeManagedFleetSession).toHaveBeenCalledWith("remote-control")
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

  it("retries on the same host but requires a safe checkpoint to migrate", async () => {
    let now = 500
    const coordinator = createDurableTeamCoordinator({ now: () => now })
    await coordinator.prepareRun(team(), "run-retry")
    await coordinator.registerChild({
      runId: "run-retry",
      childRunId: "child-retry",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "write",
    })
    await getDb().agentTeamChildRuns.update("child-retry", {
      hostRef: "device:a",
      status: "needs_input",
      dispatchLeaseId: "dispatch:old-attempt",
      dispatchLeaseExpiresAt: 60_000,
    })

    await expect(coordinator.retryChild("child-retry", "device:b")).rejects.toThrow(
      "Cross-host retry requires a safe checkpoint"
    )
    const sameHost = await coordinator.retryChild("child-retry", "device:a")
    expect(sameHost).toMatchObject({
      status: "queued",
      waitingReason: "retry_host:device:a",
    })
    expect(sameHost.dispatchLeaseId).toBeUndefined()
    expect(sameHost.dispatchLeaseExpiresAt).toBeUndefined()

    now = 550
    await coordinator.checkpoint("child-retry", {
      trajectorySequence: 0,
      replay: "safe",
      sideEffects: [],
    })
    const migrated = await coordinator.retryChild("child-retry", "device:b")
    expect(migrated.waitingReason).toBe("retry_host:device:b")
    expect((await getDb().agentTeamRuns.get("run-retry"))?.status).toBe("recovering")
  })

  it("requeues a remote child from a safe checkpoint without reopening its old session", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 1_000 })
    await coordinator.prepareRun(team(), "run-remote-resume")
    await coordinator.registerChild({
      runId: "run-remote-resume",
      childRunId: "child-remote-resume",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
    })
    await getDb().agentTeamChildRuns.update("child-remote-resume", {
      remoteSessionId: "remote-session-1",
      attempt: 1,
    })
    const resume = jest.fn(async () => undefined)
    coordinator.attachLiveControl("child-remote-resume", {
      steer: jest.fn(async () => undefined),
      resume,
    })

    await expect(coordinator.resumeChild("child-remote-resume")).rejects.toThrow("safe checkpoint")
    await coordinator.checkpoint("child-remote-resume", {
      trajectorySequence: 0,
      replay: "safe",
      sideEffects: [],
    })
    await coordinator.resumeChild("child-remote-resume")

    expect(resume).not.toHaveBeenCalled()
    expect(await getDb().agentTeamChildRuns.get("child-remote-resume")).toMatchObject({
      status: "queued",
      attempt: 1,
    })
    expect(
      (await getDb().agentTeamChildRuns.get("child-remote-resume"))?.remoteSessionId
    ).toBeUndefined()
  })

  it("does not overwrite a terminal child that settles while pause waits for idle", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 1_100 })
    await coordinator.prepareRun(team(), "run-pause-race")
    await coordinator.registerChild({
      runId: "run-pause-race",
      childRunId: "child-pause-race",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
    })
    coordinator.attachLiveControl("child-pause-race", {
      steer: jest.fn(async () => undefined),
      pause: async () => {
        await getDb().agentTeamChildRuns.update("child-pause-race", { status: "completed" })
        return true
      },
    })

    await coordinator.pauseChild("child-pause-race")
    expect((await getDb().agentTeamChildRuns.get("child-pause-race"))?.status).toBe("completed")
  })

  it("routes an unsafe cooperative pause to needs_input", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 1_200 })
    await coordinator.prepareRun(team(), "run-pause-unsafe")
    await coordinator.registerChild({
      runId: "run-pause-unsafe",
      childRunId: "child-pause-unsafe",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
    })
    coordinator.attachLiveControl("child-pause-unsafe", {
      steer: jest.fn(async () => undefined),
      pause: jest.fn(async () => false),
    })

    await coordinator.pauseChild("child-pause-unsafe")
    expect((await getDb().agentTeamChildRuns.get("child-pause-unsafe"))?.status).toBe("needs_input")
  })

  it("blocks new child admission while a cooperative pause waits for idle", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 1_300 })
    await coordinator.prepareRun(team(), "run-pause-admission")
    await coordinator.registerChild({
      runId: "run-pause-admission",
      childRunId: "child-pause-admission",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      access: "read",
    })
    let releasePause!: () => void
    coordinator.attachLiveControl("child-pause-admission", {
      steer: jest.fn(async () => undefined),
      pause: () => new Promise<boolean>((resolve) => (releasePause = () => resolve(true))),
    })

    const pausing = coordinator.pauseChild("child-pause-admission")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await getDb().agentTeamChildRuns.get("child-pause-admission"))?.status).toBe("pausing")
    await expect(
      coordinator.withChildAdmission("child-pause-admission", async () => undefined)
    ).rejects.toThrow("not accepting new turns")
    releasePause()
    await pausing
    expect((await getDb().agentTeamChildRuns.get("child-pause-admission"))?.status).toBe("paused")
  })
})
