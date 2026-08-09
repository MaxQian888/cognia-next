import "fake-indexeddb/auto"

import {
  createAgentTeamChildRun,
  createAgentTeamRun,
  getAgentTeamRun,
} from "@/lib/db/agent-team-runtime"
import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { controlDurableRun } from "./durable-control"

describe("durable AgentTeam run controls", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
    await createAgentTeamRun({
      id: "run-1",
      teamId: "team-1",
      objective: "Control the run",
      status: "running",
      priority: 1,
      decisionVersion: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    await createAgentTeamChildRun({
      id: "child-1",
      runId: "run-1",
      teamId: "team-1",
      teammateId: "mate-1",
      taskId: "task-1",
      repositoryId: "primary",
      status: "running",
      attempt: 1,
      resourceUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        wallTimeMs: 0,
        toolTimeMs: 0,
        attempts: 1,
        failures: 0,
      },
      createdAt: 2,
      updatedAt: 2,
    })
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("persists pause and resume around child controls", async () => {
    const coordinator = {
      pauseChild: jest.fn(async () => undefined),
      resumeChild: jest.fn(async () => undefined),
      sleepChild: jest.fn(async () => undefined),
      wakeChild: jest.fn(async () => undefined),
      terminateChild: jest.fn(async () => undefined),
      setRunPaused: jest.fn(),
    }
    await controlDurableRun("run-1", "pause", {
      coordinator: coordinator as never,
      now: () => 10,
    })
    expect(coordinator.pauseChild).toHaveBeenCalledWith("child-1")
    expect((await getAgentTeamRun("run-1"))?.status).toBe("paused")

    await controlDurableRun("run-1", "resume", {
      coordinator: coordinator as never,
      now: () => 11,
    })
    expect(coordinator.resumeChild).toHaveBeenCalledWith("child-1")
    expect((await getAgentTeamRun("run-1"))?.status).toBe("running")
  })

  it("terminates active children and records a terminal timestamp", async () => {
    const terminateChild = jest.fn(async () => undefined)
    await controlDurableRun("run-1", "terminate", {
      coordinator: {
        pauseChild: jest.fn(),
        resumeChild: jest.fn(),
        sleepChild: jest.fn(),
        wakeChild: jest.fn(),
        terminateChild,
        setRunPaused: jest.fn(),
      } as never,
      now: () => 20,
    })
    expect(terminateChild).toHaveBeenCalledWith("child-1")
    expect(await getAgentTeamRun("run-1")).toMatchObject({ status: "terminated", completedAt: 20 })
  })
})
