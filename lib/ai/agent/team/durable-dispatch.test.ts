import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { ProjectEnvironmentVersion } from "@/types/project-environment"
import { createLocalTauriExecutionEnvironment } from "../execution/local-tauri-environment"
import { createDurableTeamCoordinator } from "./durable-runtime"
import { beginDurableDispatch } from "./durable-dispatch"
import { createDecisionLedger } from "./decision-ledger"

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
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
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
