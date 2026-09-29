import type { ChatSession } from "@cognia/agent-config-types"
import type { SpawnedTaskBrief } from "@/lib/tasks/spawn-task-core"
import {
  disableProjectCoordination,
  enableProjectCoordination,
  startProposedThread,
} from "./user-actions"

const brief: SpawnedTaskBrief = {
  title: "Fix",
  tldr: "t",
  situation: "s",
  codeLocations: [],
  solution: "x",
  caveats: [],
  mode: "aside",
}

describe("enable / disable", () => {
  it("enables, then ensures the coordinator", async () => {
    const update = jest.fn()
    const ensure = jest.fn(async () => ({ id: "c" }) as ChatSession)
    await expect(
      enableProjectCoordination("p1", "Coordinator", { update, ensure })
    ).resolves.toEqual({
      id: "c",
    })
    expect(update).toHaveBeenCalledWith("p1", { enabled: true })
    expect(ensure).toHaveBeenCalledWith({ projectId: "p1", title: "Coordinator" })
  })

  it("disables without touching the rows", () => {
    const update = jest.fn()
    disableProjectCoordination("p1", update)
    expect(update).toHaveBeenCalledWith("p1", { enabled: false })
  })
})

describe("startProposedThread", () => {
  it("creates the thread as the user's and starts it past the soft limits", async () => {
    const create = jest.fn(async () => ({ id: "t1" }) as ChatSession)
    const start = jest.fn(async () => ({ kind: "started" as const }))
    const result = await startProposedThread(
      { projectId: "p1", coordinatorSessionId: "c", brief, rootId: "r" },
      { check: async () => ({ kind: "allow" }), create, start }
    )
    expect(create).toHaveBeenCalledWith({
      projectId: "p1",
      coordinatorSessionId: "c",
      brief,
      rootId: "r",
      proposedBy: "user",
    })
    expect(start).toHaveBeenCalledWith("t1", "user")
    expect(result).toEqual({ kind: "created", thread: { id: "t1" }, start: { kind: "started" } })
  })

  it("refuses at the hard limits without creating", async () => {
    const create = jest.fn()
    await expect(
      startProposedThread(
        { projectId: "p1", coordinatorSessionId: "c", brief },
        { check: async () => ({ kind: "refuse", reason: "daily-cap" }), create, start: jest.fn() }
      )
    ).resolves.toEqual({ kind: "refused", reason: "daily-cap" })
    expect(create).not.toHaveBeenCalled()
  })
})
