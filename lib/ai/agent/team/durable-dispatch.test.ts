import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { ProjectEnvironmentVersion } from "@/types/project-environment"
import { createLocalTauriExecutionEnvironment } from "../execution/local-tauri-environment"
import { createDurableTeamCoordinator } from "./durable-runtime"
import { beginDurableDispatch } from "./durable-dispatch"
import { createDecisionLedger } from "./decision-ledger"
import * as runtimeDb from "@/lib/db/agent-team-runtime"

jest.mock("@/lib/db/agent-team-runtime", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/db/agent-team-runtime"),
}))

const team = {
  id: "team-1",
  name: "Team",
  description: "",
  task: "Ship",
  status: "idle",
  config: {
    maxTeammates: 2,
    maxConcurrentTeammates: 1,
    executionMode: "coordinated",
    displayMode: "expanded",
    runtimeVersion: "durable-v2",
    writeMode: "single-writer",
    repositories: [{ id: "primary", role: "primary", path: "/repo", writable: true }],
  },
  leadId: "lead",
  teammateIds: ["lead", "mate"],
  taskIds: ["task"],
  messageIds: [],
  progress: 0,
  totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  createdAt: new Date(1),
} as AgentTeam

describe("durable dispatch bridge", () => {
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

  const openDispatch = async (runId: string, access: "read" | "write" = "read") => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team, runId)
    const input = {
      coordinator,
      team,
      runId,
      teammateId: "mate",
      taskId: "task",
      access,
      repositoryId: "primary",
    }
    return { coordinator, input, dispatch: await beginDurableDispatch(input) }
  }

  it("admits only one simultaneous begin for the same task and teammate", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team, "run-concurrent-begin")
    const input = {
      coordinator,
      team,
      runId: "run-concurrent-begin",
      teammateId: "mate",
      taskId: "task",
      access: "read" as const,
      repositoryId: "primary",
    }
    const results = await Promise.allSettled([
      beginDurableDispatch(input),
      beginDurableDispatch(input),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(await runtimeDb.listAgentTeamChildRuns(input.runId)).toEqual([
      expect.objectContaining({ status: "running", attempt: 1 }),
    ])
    expect(await runtimeDb.getAgentTeamRun(input.runId)).toMatchObject({ status: "running" })
  })

  it("rejects a second begin without changing the active owner's attempt or run", async () => {
    const { input, dispatch } = await openDispatch("run-owned-begin")
    await expect(beginDurableDispatch(input)).rejects.toThrow("already has an active dispatch")
    expect(await runtimeDb.getAgentTeamChildRun(dispatch.childRunId)).toMatchObject({
      status: "running",
      attempt: 1,
    })
    expect(await runtimeDb.getAgentTeamRun(input.runId)).toMatchObject({ status: "running" })
    await dispatch.complete({ text: "owner completed normally" })
  })

  it("keeps an older failed handle from settling a newer retry attempt", async () => {
    const { input, dispatch: first } = await openDispatch("run-attempt-owner")
    await first.fail(new Error("first attempt failed"))
    const second = await beginDurableDispatch(input)
    await expect(first.complete({ text: "stale result" })).rejects.toThrow("no longer owns")
    await first.fail(new Error("late first-attempt failure"))
    expect(await runtimeDb.getAgentTeamChildRun(second.childRunId)).toMatchObject({
      status: "running",
      attempt: 2,
    })
    const staleOperation = jest.fn(async () => "stale execution")
    await expect(first.run(staleOperation)).rejects.toThrow("no longer owns")
    expect(staleOperation).not.toHaveBeenCalled()
    first.capture({ type: "tool-call", id: "stale", toolName: "Write", input: {} })
    await expect(first.flush()).rejects.toThrow("no longer owns")
    expect(
      (await runtimeDb.listAgentTeamTrajectory(input.runId)).some(
        (event) => event.correlationId === "stale"
      )
    ).toBe(false)
    await second.complete({ text: "fresh result" })
  })

  it("does not let a duplicate begin replace a child waiting for scheduler admission", async () => {
    const coordinator = createDurableTeamCoordinator({ globalConcurrency: 1 })
    await coordinator.prepareRun(team, "run-admission-owner")
    const input = {
      coordinator,
      team,
      runId: "run-admission-owner",
      teammateId: "mate",
      taskId: "task",
      access: "read" as const,
      repositoryId: "primary",
    }
    const blocker = await beginDurableDispatch({ ...input, taskId: "blocker" })
    const queued = await beginDurableDispatch(input)
    let release!: () => void
    const active = blocker.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
    const waiting = queued.run(async () => "queued result")
    while (coordinator.schedulerSnapshot().queued.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 1))
    try {
      await expect(beginDurableDispatch(input)).rejects.toThrow("already has an active dispatch")
      expect(await runtimeDb.getAgentTeamChildRun(queued.childRunId)).toMatchObject({
        status: "queued",
        attempt: 1,
      })
    } finally {
      release()
      await Promise.all([active, waiting])
    }
    await queued.complete({ text: "finished" })
  })

  it.each(["child_created", "model_turn_started"])(
    "rolls back child initialization after %s journal failure",
    async (kind) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(team, "run-init-failure")
      const append = runtimeDb.appendAgentTeamTrajectory
      jest
        .spyOn(runtimeDb, "appendAgentTeamTrajectory")
        .mockImplementation(async (event, content) => {
          if (event.kind === kind) throw new Error("initial journal unavailable")
          return append(event, content)
        })
      await expect(
        beginDurableDispatch({
          coordinator,
          team,
          runId: "run-init-failure",
          teammateId: "mate",
          taskId: "task",
          access: "read",
          repositoryId: "primary",
        })
      ).rejects.toThrow("initial journal unavailable")
      expect(await runtimeDb.listAgentTeamChildRuns("run-init-failure")).toEqual([])
      expect(await runtimeDb.getAgentTeamRun("run-init-failure")).toMatchObject({
        status: "needs_input",
      })
      expect(coordinator.schedulerSnapshot()).toEqual({ queued: [], active: [] })
    }
  )

  it.each(["pausing", "paused", "sleeping", "needs_input"] as const)(
    "preserves the %s child dispatch gate",
    async (status) => {
      const { input, dispatch } = await openDispatch("run-gated")
      await runtimeDb.updateAgentTeamChildRun(dispatch.childRunId, { status })
      await expect(beginDurableDispatch(input)).rejects.toThrow("not accepting dispatch")
      expect(await runtimeDb.getAgentTeamChildRun(dispatch.childRunId)).toMatchObject({
        status,
        attempt: 1,
      })
    }
  )

  it("preserves an unsafe provider pause result through the control wrapper", async () => {
    const { coordinator, dispatch } = await openDispatch("run-unsafe-pause")
    await dispatch.attachControl({ steer: async () => {}, pause: async () => false })
    await coordinator.pauseChild(dispatch.childRunId)
    expect(await runtimeDb.getAgentTeamChildRun(dispatch.childRunId)).toMatchObject({
      status: "needs_input",
    })
  })

  it.each(["fail", "checkpointPause"] as const)(
    "does not certify an unprojected remote tool call during %s",
    async (action) => {
      const { dispatch } = await openDispatch("run-remote-tail")
      await runtimeDb.appendAgentTeamTrajectory({
        runId: "run-remote-tail",
        childRunId: dispatch.childRunId,
        kind: "remote_event",
        correlationId: "tool-unprojected",
        createdAt: Date.now(),
        payload: { event: { kind: "tool-call", toolName: "Write" } },
      })
      if (action === "fail") await dispatch.fail(new Error("projection failed"))
      else await expect(dispatch.checkpointPause()).resolves.toBe(false)
      expect(await runtimeDb.getLatestAgentTeamCheckpoint(dispatch.childRunId)).toMatchObject({
        replay: "needs_input",
      })
    }
  )

  it("keeps a local text-only failure replayable without a previous checkpoint", async () => {
    const { dispatch } = await openDispatch("run-local-failure")
    await dispatch.fail(new Error("provider unavailable"))
    expect(await runtimeDb.getLatestAgentTeamCheckpoint(dispatch.childRunId)).toMatchObject({
      replay: "safe",
    })
    expect(await runtimeDb.getAgentTeamChildRun(dispatch.childRunId)).toMatchObject({
      status: "failed",
    })
  })

  it("refuses completion while a tool has no settled result", async () => {
    const { dispatch } = await openDispatch("run-unsettled-tool")
    dispatch.capture({
      type: "tool-call",
      id: "write",
      toolName: "Write",
      input: { path: "src/main.ts" },
    })
    await expect(dispatch.complete({ text: "done" })).rejects.toThrow("unsettled tool")
    expect(await runtimeDb.getAgentTeamChildRun(dispatch.childRunId)).toMatchObject({
      status: "needs_input",
    })
    expect(await runtimeDb.getLatestAgentTeamCheckpoint(dispatch.childRunId)).toMatchObject({
      replay: "needs_input",
    })
  })

  it.each([
    ["Read", "pnpm test"],
    ["Bash", "pnpm test --help"],
    ["Bash", "pnpm test '--listTests'"],
    ["Bash", "pnpm test --passWithNoTests"],
    ["Bash", "cargo test --no-run"],
    ["Bash", "pnpm lint --fix"],
    ["Bash", "pnpm test > src/generated.ts"],
  ])("does not certify %s %s as verification", async (toolName, command) => {
    const { dispatch } = await openDispatch("run-verifier-command", "write")
    dispatch.capture({
      type: "tool-result",
      toolName,
      input: { command },
      result: "ok",
      isError: false,
    })
    await expect(dispatch.complete({ text: "done", commitSha: "abc" })).rejects.toThrow(
      "verification"
    )
  })

  it.each([false, true])(
    "does not hide a failing check behind other successful checks (retried=%s)",
    async (retried) => {
      const { dispatch } = await openDispatch("run-verification-retry", "write")
      const checks: Array<[string, boolean]> = [
        ["pnpm test", false],
        ["pnpm test", true],
        ["pnpm lint", false],
      ]
      if (retried) checks.push(["pnpm test", false])
      for (const [command, isError] of checks) {
        dispatch.capture({
          type: "tool-result",
          toolName: "Bash",
          input: { command },
          result: isError ? "failed" : "passed",
          isError,
        })
      }
      const completion = dispatch.complete({ text: "done", commitSha: "abc" })
      if (retried) await expect(completion).resolves.toBeUndefined()
      else await expect(completion).rejects.toThrow("verification")
    }
  )

  it("records a recoverable failure after a checkpoint write fails", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 10 })
    await coordinator.prepareRun(team, "run-storage-failure")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-storage-failure",
      teammateId: "mate",
      taskId: "task",
      access: "read",
      repositoryId: "primary",
    })
    const checkpoint = jest
      .spyOn(coordinator, "checkpoint")
      .mockRejectedValueOnce(new Error("storage unavailable"))
    dispatch.capture({ type: "tool-call", id: "write-1", toolName: "Write", input: {} })
    await expect(dispatch.complete({ text: "done" })).rejects.toThrow("storage unavailable")
    await dispatch.fail(new Error("turn failed"))
    expect(await getDb().agentTeamChildRuns.get(dispatch.childRunId)).toMatchObject({
      status: "needs_input",
    })
    expect(checkpoint).toHaveBeenCalledTimes(2)
  })

  it("does not let failed verification satisfy the evidence gate", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 10 })
    await coordinator.prepareRun(team, "run-failed-test")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-failed-test",
      teammateId: "mate",
      taskId: "task",
      access: "write",
      repositoryId: "primary",
    })
    dispatch.capture({
      type: "tool-result",
      id: "test-1",
      toolName: "Bash",
      input: { command: "pnpm test" },
      result: "FAIL",
      isError: true,
    })
    await expect(dispatch.complete({ text: "done", commitSha: "abc" })).rejects.toThrow(
      "Evidence gate"
    )
  })

  it.each(["unconfirmed", "later-edit", "masked-exit"])(
    "rejects %s verification evidence",
    async (scenario) => {
      const coordinator = createDurableTeamCoordinator()
      await coordinator.prepareRun(team, "run-unverified")
      const dispatch = await beginDurableDispatch({
        coordinator,
        team,
        runId: "run-unverified",
        teammateId: "mate",
        taskId: "task",
        access: "write",
        repositoryId: "primary",
      })
      dispatch.capture({
        type: "tool-result",
        toolName: "Bash",
        input: { command: scenario === "masked-exit" ? "pnpm test; true" : "pnpm test" },
        result: "output",
        ...(scenario === "unconfirmed" ? {} : { isError: false }),
      })
      if (scenario === "later-edit")
        dispatch.capture({
          type: "tool-result",
          toolName: "Write",
          result: "edited",
          isError: false,
        })
      await expect(dispatch.complete({ text: "done", commitSha: "abc" })).rejects.toThrow(
        "verification"
      )
    }
  )

  it("keeps steering replayable until the turn completes", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team, "run-steering")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-steering",
      teammateId: "mate",
      taskId: "task",
      access: "read",
      repositoryId: "primary",
    })
    const receipt = await coordinator.steer(dispatch.childRunId, "Inspect only")
    await dispatch.prepareTurnContext()
    expect(await getDb().agentTeamSteeringReceipts.get(receipt.id)).toMatchObject({
      status: "delivered",
    })
    await dispatch.complete({ text: "inspected" })
    expect(await getDb().agentTeamSteeringReceipts.get(receipt.id)).toMatchObject({
      status: "applied",
    })
  })

  it("requires a settled revision and binds verification to the workspace snapshot", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team, "run-revision")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-revision",
      teammateId: "mate",
      taskId: "task",
      access: "write",
      repositoryId: "primary",
    })
    dispatch.capture({
      type: "tool-call",
      id: "test",
      toolName: "Bash",
      input: { command: "pnpm test" },
    })
    dispatch.capture({
      type: "tool-result",
      id: "test",
      toolName: "Bash",
      result: "passed",
      isError: false,
    })
    await dispatch.complete({
      text: "done",
      diffContent: "changes",
      workspaceRevision: "workspace:sha256:snapshot",
    })
    const evidence = await getDb()
      .agentTeamEvidence.where("childRunId")
      .equals(dispatch.childRunId)
      .toArray()
    expect(evidence.find((item) => item.kind === "test")).toMatchObject({
      revision: "workspace:sha256:snapshot",
      status: "passed",
    })
    expect(await getDb().agentTeamChildRuns.get(dispatch.childRunId)).toMatchObject({
      status: "completed",
    })
  })

  it("rejects code results without a verifiable workspace revision", async () => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team, "run-no-revision")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-no-revision",
      teammateId: "mate",
      taskId: "task",
      access: "write",
      repositoryId: "primary",
    })
    dispatch.capture({
      type: "tool-result",
      toolName: "Bash",
      input: { command: "pnpm test" },
      result: "passed",
      isError: false,
    })
    await expect(dispatch.complete({ text: "done", diffContent: "changes" })).rejects.toThrow(
      "revision"
    )
  })

  it.each([
    "completed",
    "failed",
    "cancelled",
    "terminated",
    "paused",
    "pausing",
    "sleeping",
    "needs_input",
  ])("does not revive a %s child on late completion or worker waiting", async (status) => {
    const coordinator = createDurableTeamCoordinator()
    await coordinator.prepareRun(team, "run-late")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-late",
      teammateId: "mate",
      taskId: "task",
      access: "read",
      repositoryId: "primary",
    })
    await getDb().agentTeamChildRuns.update(dispatch.childRunId, { status: status as "completed" })
    await expect(dispatch.complete({ text: "late" })).rejects.toThrow("no longer active")
    await expect(dispatch.wait("worker unavailable", "host")).rejects.toThrow("no longer active")
    expect(await getDb().agentTeamChildRuns.get(dispatch.childRunId)).toMatchObject({ status })
  })

  it("records write-ahead tool trajectory, evidence, usage and a safe checkpoint", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 10 })
    await coordinator.prepareRun(team, "run-1")
    let currentTime = 20
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-1",
      teammateId: "mate",
      taskId: "task",
      access: "write",
      repositoryId: "primary",
      now: () => currentTime,
    })
    dispatch.capture({
      type: "tool-call",
      id: "tool-1",
      toolName: "Bash",
      input: { command: "pnpm test" },
    })
    currentTime = 55
    dispatch.capture({
      type: "tool-result",
      id: "tool-1",
      toolName: "Bash",
      input: { command: "pnpm test" },
      result: "7 passed",
      isError: false,
    })
    currentTime = 80
    await dispatch.complete({
      text: "Implemented and verified",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costUsd: 0.0123,
      commitSha: "abc123",
    })

    const child = await getDb().agentTeamChildRuns.get(dispatch.childRunId)
    expect(child).toMatchObject({
      status: "completed",
      resourceUsage: {
        totalTokens: 15,
        costUsd: 0.0123,
        toolTimeMs: 35,
        attempts: 1,
        failures: 0,
      },
    })
    expect(
      (await getDb().agentTeamTrajectory.where("runId").equals("run-1").toArray()).map(
        (e) => e.kind
      )
    ).toEqual(
      expect.arrayContaining(["tool_intent", "tool_result", "model_turn_completed", "checkpoint"])
    )
    expect(
      (await getDb().agentTeamEvidence.where("taskId").equals("task").toArray()).map((e) => e.kind)
    ).toEqual(expect.arrayContaining(["activity", "outcome", "test", "commit"]))
    const checkpoints = await getDb().agentTeamCheckpoints.where("runId").equals("run-1").toArray()
    expect(checkpoints).toHaveLength(3)
    expect(checkpoints.filter((checkpoint) => checkpoint.replay === "needs_input")).toHaveLength(1)
    expect(checkpoints.filter((checkpoint) => checkpoint.replay === "safe")).toHaveLength(2)
  })

  it("redacts tool payloads before trajectory and evidence persistence", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 30 })
    await coordinator.prepareRun(team, "run-redact")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team: {
        ...team,
        config: {
          ...team.config,
          evidencePolicy: {
            requireActivity: true,
            requireOutcome: true,
            requireCodeDiff: false,
            requireVerification: false,
            requireVisualForUi: false,
          },
        },
      },
      runId: "run-redact",
      teammateId: "mate",
      taskId: "task-redact",
      access: "read",
      repositoryId: "primary",
      now: () => 31,
    })
    dispatch.capture({
      type: "tool-call",
      id: "secret-tool",
      toolName: "Bash",
      input: { command: "echo user@example.com" },
    })
    dispatch.capture({
      type: "tool-result",
      id: "secret-tool",
      toolName: "Bash",
      input: { command: "echo user@example.com" },
      result: "user@example.com",
      isError: false,
    })
    await dispatch.complete({ text: "Finished" })

    const trajectory = await getDb()
      .agentTeamTrajectory.where("runId")
      .equals("run-redact")
      .toArray()
    expect(JSON.stringify(trajectory)).not.toContain("user@example.com")
    const objects = await getDb().agentTeamContentObjects.toArray()
    expect(objects.map((object) => new TextDecoder().decode(object.data)).join("\n")).not.toContain(
      "user@example.com"
    )
  })

  it("preserves attempt and failure accounting when a child resumes", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 35 })
    await coordinator.prepareRun(team, "run-retry")
    const first = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-retry",
      teammateId: "mate",
      taskId: "task-retry",
      access: "read",
      repositoryId: "primary",
      now: () => 36,
    })
    await first.fail(new Error("provider unavailable"))

    const resumed = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-retry",
      teammateId: "mate",
      taskId: "task-retry",
      access: "read",
      repositoryId: "primary",
      now: () => 37,
    })
    expect(resumed.childRunId).toBe(first.childRunId)
    await resumed.complete({ text: "Recovered result" })

    const child = await getDb().agentTeamChildRuns.get(resumed.childRunId)
    expect(child?.resourceUsage).toMatchObject({ attempts: 2, failures: 1 })
  })

  it("refreshes queued children to the latest accepted decision version at the turn boundary", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 38 })
    await coordinator.prepareRun(team, "run-decisions")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-decisions",
      teammateId: "mate",
      taskId: "task-decisions",
      access: "write",
      repositoryId: "primary",
      now: () => 39,
    })
    const ledger = createDecisionLedger({ runId: "run-decisions", leadId: "lead", now: () => 40 })
    await getDb().agentTeamEvidence.put({
      id: "evidence-1",
      runId: "run-decisions",
      childRunId: dispatch.childRunId,
      taskId: "task-decisions",
      kind: "activity",
      title: "Migration inspection",
      createdAt: 40,
    })
    const proposal = await ledger.propose({
      authorId: "mate",
      title: "Migration strategy",
      detail: "Use an additive migration",
      evidenceIds: ["evidence-1"],
    })
    await ledger.accept(proposal.id, "lead")

    const context = await dispatch.prepareTurnContext()
    expect(context).toContain("DECISION v1")
    expect(context).toContain("Use an additive migration")
    expect((await getDb().agentTeamChildRuns.get(dispatch.childRunId))?.decisionVersion).toBe(1)
  })

  it("unifies provider and local environment lifecycle control for a durable child", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 40 })
    await coordinator.prepareRun(team, "run-control")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-control",
      teammateId: "mate",
      taskId: "task-control",
      access: "read",
      repositoryId: "primary",
      now: () => 41,
    })
    const settle = jest.fn(async () => [])
    const environment = createLocalTauriExecutionEnvironment({
      isTauri: () => true,
      executeSetup: async () => ({ success: true }),
      openWorkspace: async () => ({ executionRoot: "/worktree", settle }),
    })
    const profile: ProjectEnvironmentVersion = {
      id: "env:v1",
      environmentId: "env",
      projectId: "project",
      version: 1,
      name: "Local",
      setupScript: { default: "" },
      actions: [],
      variables: {},
      keyringReferences: [],
      policy: { requiredRuntimeCapabilities: ["filesystem"] },
      createdAt: 1,
    }
    const prepared = await environment.prepare(profile, "/repo")
    await environment.openChild({
      runId: "run-control",
      childRunId: dispatch.childRunId,
      taskId: "task-control",
      teammateId: "mate",
      repositoryPath: "/repo",
      profile: prepared,
    })
    dispatch.attachEnvironment(environment)
    const pause = jest.fn(async () => undefined)
    const resume = jest.fn(async () => undefined)
    const terminate = jest.fn(async () => undefined)
    await dispatch.attachControl({ steer: async () => undefined, pause, resume, terminate })

    await coordinator.pauseChild(dispatch.childRunId)
    expect(environment.resourceHealth(dispatch.childRunId)?.state).toBe("suspended")
    await coordinator.resumeChild(dispatch.childRunId)
    expect(environment.resourceHealth(dispatch.childRunId)?.state).toBe("running")
    await coordinator.terminateChild(dispatch.childRunId)

    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(environment.resourceHealth(dispatch.childRunId)?.state).toBe("terminated")
    expect(settle).toHaveBeenCalledWith("cancelled")
  })

  it("keeps an unavailable remote child queued and marks the run as waiting", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 50 })
    await coordinator.prepareRun(team, "run-waiting")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-waiting",
      teammateId: "mate",
      taskId: "task-waiting",
      access: "read",
      repositoryId: "primary",
      now: () => 51,
    })

    await dispatch.wait("pinned_host_offline", "device:worker-a")

    expect(await getDb().agentTeamChildRuns.get(dispatch.childRunId)).toMatchObject({
      status: "queued",
      hostRef: "device:worker-a",
      waitingReason: "pinned_host_offline",
    })
    expect(await getDb().agentTeamRuns.get("run-waiting")).toMatchObject({
      status: "needs_input",
      recoveryReason: "worker_waiting:pinned_host_offline",
    })
  })

  it("records a safe durable checkpoint after remote pause reaches idle", async () => {
    const coordinator = createDurableTeamCoordinator({ now: () => 60 })
    await coordinator.prepareRun(team, "run-pause-checkpoint")
    const dispatch = await beginDurableDispatch({
      coordinator,
      team,
      runId: "run-pause-checkpoint",
      teammateId: "mate",
      taskId: "task-pause-checkpoint",
      access: "read",
      repositoryId: "primary",
      now: () => 61,
    })

    await expect(dispatch.checkpointPause()).resolves.toBe(true)
    const checkpoint = await getDb()
      .agentTeamCheckpoints.where("childRunId")
      .equals(dispatch.childRunId)
      .last()
    expect(checkpoint).toMatchObject({ replay: "safe", sideEffects: [] })
  })
})
