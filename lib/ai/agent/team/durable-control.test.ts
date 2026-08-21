import "fake-indexeddb/auto"

import {
  createAgentTeamChildRun,
  createAgentTeamRun,
  getAgentTeamRun,
} from "@/lib/db/agent-team-runtime"
import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { controlDurableRun, steerDurableRun } from "./durable-control"

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

describe("steering a durable run", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
    await createAgentTeamRun({
      id: "run-s",
      teamId: "team-1",
      objective: "Steer the run",
      status: "running",
      priority: 1,
      decisionVersion: 0,
      createdAt: 1,
      updatedAt: 1,
    })
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  async function addChild(id: string, status: "running" | "completed") {
    await createAgentTeamChildRun({
      id,
      runId: "run-s",
      teamId: "team-1",
      teammateId: "mate-1",
      taskId: `task-${id}`,
      repositoryId: "primary",
      status,
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
  }

  it("fans the correction out to every child that can still act", async () => {
    // Steering only the lead would leave the workers running on the very
    // instruction the person just corrected.
    await addChild("child-a", "running")
    await addChild("child-b", "running")
    await addChild("child-done", "completed")
    const steer = jest.fn(async (childRunId: string) => ({ id: `receipt-${childRunId}` }))

    const result = await steerDurableRun("run-s", "prefer the smaller diff", {
      coordinator: { steer } as never,
      now: () => 10,
    })

    expect(steer).toHaveBeenCalledTimes(2)
    expect(result.childCount).toBe(2)
    expect(result.receiptIds.sort()).toEqual(["receipt-child-a", "receipt-child-b"])
  })

  it("records receipt ids on the trajectory and never the message itself", async () => {
    await addChild("child-a", "running")
    const steer = jest.fn(async () => ({ id: "receipt-1" }))

    await steerDurableRun("run-s", "my email is dana@example.com", {
      coordinator: { steer } as never,
      now: () => 10,
    })

    const rows = await getDb().agentTeamTrajectory.toArray()
    const serialized = JSON.stringify(rows)
    expect(serialized).toContain("receipt-1")
    expect(serialized).not.toContain("dana@example.com")
  })

  it("lets the other children through when one refuses", async () => {
    await addChild("child-a", "running")
    await addChild("child-b", "running")
    const steer = jest.fn(async (childRunId: string) => {
      if (childRunId === "child-a") throw new Error("child is mid-checkpoint")
      return { id: "receipt-b" }
    })

    const result = await steerDurableRun("run-s", "go", {
      coordinator: { steer } as never,
      now: () => 10,
    })

    expect(result.receiptIds).toEqual(["receipt-b"])
    expect(result.childCount).toBe(2)
  })

  it("reports nothing to steer rather than inventing a receipt", async () => {
    await addChild("child-done", "completed")
    const steer = jest.fn()

    const result = await steerDurableRun("run-s", "go", {
      coordinator: { steer } as never,
      now: () => 10,
    })

    expect(result).toEqual({ receiptIds: [], childCount: 0 })
    expect(steer).not.toHaveBeenCalled()
  })
})
