import type { ChatSession } from "@cognia/agent-config-types"
import type { Project, ProjectCoordinatorConfig } from "@/types"
import type { ChatStatus } from "@/stores/chat/chat-store"
import { pauseProject, resumeProject, type PauseDeps } from "./pause"
import type { ThreadRuntimeDeps } from "./thread-runtime"

jest.mock("./pr-watch", () => ({ getProjectPrWatch: jest.fn() }))

const NOW = 5_000

function thread(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: "p1",
    projectRole: "thread",
    projectThread: { coordinatorSessionId: "coord", brief: "b", proposedBy: "coordinator" },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as ChatSession
}

function setup(
  coordinator: ProjectCoordinatorConfig | undefined,
  threads: ChatSession[] = [],
  statuses: Record<string, ChatStatus> = {},
  queued: string[] = []
) {
  let current = coordinator
  const runtime = {
    listThreads: jest.fn(async () => threads),
    statusOf: (id: string) => statuses[id] ?? "idle",
    cancelQueued: jest.fn((id: string) => queued.includes(id)),
    stopTurn: jest.fn(async () => true),
    now: () => NOW,
  } as unknown as ThreadRuntimeDeps
  const deps: PauseDeps = {
    getProject: (id) => (id === "p1" ? ({ id: "p1", coordinator: current } as Project) : undefined),
    updateCoordinator: jest.fn((_id, patch) => {
      current = { ...current, ...patch, enabled: current?.enabled ?? false }
      return { id: "p1", coordinator: current } as Project
    }),
    runtime,
    stopThread: jest.fn(async () => undefined),
    untrackPr: jest.fn(),
    resumeThreads: jest.fn(async () => undefined),
  }
  return { deps, runtime, config: () => current }
}

describe("pauseProject", () => {
  it("records the pause and stops every live thread and the coordinator", async () => {
    const { deps, runtime, config } = setup(
      { enabled: true, sessionId: "coord" },
      [thread("busy"), thread("queued"), thread("idle"), thread("unsent")],
      { busy: "streaming", coord: "awaiting_approval" },
      ["queued"]
    )
    await pauseProject("p1", { reason: "  over budget " }, deps)

    expect(config()?.paused).toEqual({ at: NOW, reason: "over budget" })
    expect((deps.stopThread as jest.Mock).mock.calls.map(([id]) => id)).toEqual(["busy", "queued"])
    expect((deps.untrackPr as jest.Mock).mock.calls.map(([id]) => id)).toEqual([
      "busy",
      "queued",
      "idle",
      "unsent",
    ])
    expect(runtime.cancelQueued).toHaveBeenCalledWith("coord")
    expect(runtime.stopTurn).toHaveBeenCalledWith("coord")
  })

  it("leaves an idle coordinator alone and keeps an existing pause", async () => {
    const { deps, runtime } = setup({ enabled: true, sessionId: "coord", paused: { at: 1 } })
    await pauseProject("p1", {}, deps)
    expect(deps.updateCoordinator).not.toHaveBeenCalled()
    expect(runtime.stopTurn).not.toHaveBeenCalled()
  })

  it("pauses a project that has no coordinator yet without touching sessions", async () => {
    const { deps, runtime, config } = setup({ enabled: true })
    await pauseProject("p1", undefined, deps)
    expect(config()?.paused).toEqual({ at: NOW })
    expect(runtime.listThreads).not.toHaveBeenCalled()
  })

  it("throws for an unknown workspace", async () => {
    const { deps } = setup(undefined)
    await expect(pauseProject("nope", {}, deps)).rejects.toThrow(/nope/)
  })
})

describe("resumeProject", () => {
  it("clears the pause and delivers the briefs held back", async () => {
    const { deps, config } = setup({ enabled: true, sessionId: "coord", paused: { at: 1 } })
    await resumeProject("p1", deps)
    expect(config()?.paused).toBeUndefined()
    expect(deps.resumeThreads).toHaveBeenCalledWith("coord")
  })

  it("does nothing for a project that is not paused", async () => {
    const { deps } = setup({ enabled: true, sessionId: "coord" })
    await resumeProject("p1", deps)
    expect(deps.updateCoordinator).not.toHaveBeenCalled()
    expect(deps.resumeThreads).not.toHaveBeenCalled()
  })

  it("throws for an unknown workspace", async () => {
    const { deps } = setup(undefined)
    await expect(resumeProject("nope", deps)).rejects.toThrow(/nope/)
  })
})
