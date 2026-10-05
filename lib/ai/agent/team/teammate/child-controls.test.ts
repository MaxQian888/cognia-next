import "fake-indexeddb/auto"

import { createMemoryTeamRunStore } from "@cognia/agent-orchestration/memory-store"
import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { AgentTeamExecutionConstraints } from "@/types/agent/agent-team-runtime"
import { beginDurableDispatch } from "../durable/durable-dispatch"
import { createDurableTeamCoordinator } from "../durable/durable-runtime"
import {
  externalSessionControl,
  remoteTurnControl,
  sidecarSessionControl,
  type ChildControlDispatch,
  type ExternalSessionControls,
} from "./child-controls"

function externalManager(retires: boolean) {
  return {
    steerSession: jest.fn(async (_agentId: string, _sessionId: string, _text: string) => undefined),
    cancel: jest.fn(async (_agentId: string, _sessionId: string) => undefined),
    cancelRetiresSession: jest.fn((_agentId: string, _sessionId: string) => retires),
  } satisfies ExternalSessionControls
}

function dispatchHandle(safe: boolean) {
  return {
    releaseSession: jest.fn(async (_sessionId: string) => undefined),
    checkpointPause: jest.fn(async () => safe),
  } satisfies ChildControlDispatch
}

describe("externalSessionControl", () => {
  it("steers and terminates the exact session", async () => {
    const manager = externalManager(false)
    const control = externalSessionControl(manager, "agent-1", "s-1", dispatchHandle(true))
    await control.steer("focus", "msg-1")
    await control.terminate?.()
    expect(manager.steerSession).toHaveBeenCalledWith("agent-1", "s-1", "focus")
    expect(manager.cancel).toHaveBeenCalledWith("agent-1", "s-1")
  })

  it("pauses a turn-scoped session without releasing it", async () => {
    const manager = externalManager(false)
    const dispatch = dispatchHandle(true)
    const control = externalSessionControl(manager, "agent-1", "s-1", dispatch)
    await expect(control.pause?.()).resolves.toBeUndefined()
    expect(manager.cancel).toHaveBeenCalledWith("agent-1", "s-1")
    expect(dispatch.releaseSession).not.toHaveBeenCalled()
    expect(dispatch.checkpointPause).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    "releases a session its cancel retires and answers with the checkpoint (safe: %s)",
    async (safe) => {
      const manager = externalManager(true)
      const dispatch = dispatchHandle(safe)
      const control = externalSessionControl(manager, "agent-1", "s-1", dispatch)
      await expect(control.pause?.()).resolves.toBe(safe)
      // Asked before the cancel: afterwards the session may already be gone.
      expect(manager.cancelRetiresSession.mock.invocationCallOrder[0]).toBeLessThan(
        manager.cancel.mock.invocationCallOrder[0]
      )
      expect(dispatch.releaseSession).toHaveBeenCalledWith("s-1")
      expect(dispatch.checkpointPause).toHaveBeenCalledTimes(1)
    }
  )
})

describe("sidecarSessionControl", () => {
  it("steers with the source message and interrupts for pause and terminate", async () => {
    const ipc = {
      steerSession: jest.fn(async () => ({ accepted: true })),
      interruptSession: jest.fn(async (_sessionId: string) => undefined),
    }
    const control = sidecarSessionControl(ipc, "sidecar-1")
    await control.steer("check", "msg-1")
    await control.pause?.()
    await control.terminate?.()
    expect(ipc.steerSession).toHaveBeenCalledWith("sidecar-1", "check", "msg-1")
    expect(ipc.interruptSession).toHaveBeenCalledTimes(2)
    expect(ipc.interruptSession).toHaveBeenCalledWith("sidecar-1")
  })
})

describe("remoteTurnControl", () => {
  it("derives command ids from the lease and answers pause with the checkpoint", async () => {
    const remote = {
      steer: jest.fn(async () => undefined),
      pause: jest.fn(async () => undefined),
      terminate: jest.fn(async () => undefined),
    }
    const dispatch = dispatchHandle(false)
    const control = remoteTurnControl(remote, "lease-1", dispatch)
    await control.steer("go", "msg-9")
    await expect(control.pause?.()).resolves.toBe(false)
    await control.terminate?.()
    expect(remote.steer).toHaveBeenCalledWith("go", "msg-9")
    expect(remote.pause).toHaveBeenCalledWith("lease-1:pause")
    expect(remote.terminate).toHaveBeenCalledWith("lease-1:terminate")
  })
})

describe("a mixed built-in and external team on one durable run", () => {
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

  const team = {
    id: "team-mixed",
    name: "Mixed",
    description: "",
    task: "Ship",
    status: "idle",
    config: {
      maxTeammates: 3,
      maxConcurrentTeammates: 2,
      executionMode: "coordinated",
      displayMode: "expanded",
      runtimeVersion: "durable-v2",
      writeMode: "single-writer",
      repositories: [{ id: "primary", role: "primary", path: "/repo", writable: true }],
    },
    leadId: "lead",
    teammateIds: ["lead", "builtin", "external"],
    taskIds: ["t-builtin", "t-external"],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(1),
  } as AgentTeam

  it("controls each child through its own backend and never pauses a retired session", async () => {
    const store = createMemoryTeamRunStore<AgentTeamExecutionConstraints>()
    const coordinator = createDurableTeamCoordinator({ store })
    await coordinator.prepareRun(team, "run-mixed")
    const begin = (teammateId: string, taskId: string, runtime: string) =>
      beginDurableDispatch({
        coordinator,
        team,
        runId: "run-mixed",
        teammateId,
        taskId,
        access: "read",
        repositoryId: "primary",
        runtime,
      })
    const builtin = await begin("builtin", "t-builtin", "claude")
    const external = await begin("external", "t-external", "dsh")

    const ipc = {
      steerSession: jest.fn(async () => ({ accepted: true })),
      interruptSession: jest.fn(async (_sessionId: string) => undefined),
    }
    // DeepSeek Harness shape: its cancel retires the session's process.
    const manager = externalManager(true)
    await builtin.attachControl(sidecarSessionControl(ipc, "sidecar-1"), "sidecar-1")
    await external.attachControl(
      externalSessionControl(manager, "agent-dsh", "dsh-1", external),
      "dsh-1"
    )

    expect(
      (await store.listChildren("run-mixed")).map((child) => [child.teammateId, child.runtime])
    ).toEqual([
      ["builtin", "claude"],
      ["external", "dsh"],
    ])

    await coordinator.steer(builtin.childRunId, "check the parser")
    await coordinator.steer(external.childRunId, "check the schema")
    expect(ipc.steerSession).toHaveBeenCalledWith(
      "sidecar-1",
      "check the parser",
      expect.any(String)
    )
    expect(manager.steerSession).toHaveBeenCalledWith("agent-dsh", "dsh-1", "check the schema")

    // The external child is mid tool call when the operator pauses the team.
    external.capture({ type: "tool-call", id: "write-1", toolName: "Write", input: {} })
    await external.flush()
    await coordinator.pauseChild(builtin.childRunId)
    await coordinator.pauseChild(external.childRunId)

    // The built-in session survives its interrupt and is paused.
    expect(ipc.interruptSession).toHaveBeenCalledWith("sidecar-1")
    expect(await store.getChild(builtin.childRunId)).toMatchObject({
      status: "paused",
      sessionId: "sidecar-1",
    })
    // The external cancel retired its session: it is forgotten, and with an
    // unfinished tool call the child needs input rather than a paused session.
    expect(manager.cancel).toHaveBeenCalledWith("agent-dsh", "dsh-1")
    const parked = await store.getChild(external.childRunId)
    expect(parked?.status).toBe("needs_input")
    expect(parked?.sessionId).toBeUndefined()

    // Steering a retired session waits in the durable queue for the next turn.
    const queued = await coordinator.steer(external.childRunId, "resume carefully")
    expect(queued.status).toBe("queued")
    expect(manager.steerSession).toHaveBeenCalledTimes(1)

    builtin.dispose()
    external.dispose()
  })
})
