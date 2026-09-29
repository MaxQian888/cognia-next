import type { ChatSession } from "@cognia/agent-config-types"
import type { Project, ProjectCoordinatorConfig } from "@/types"
import type { ChatStatus } from "@/stores/chat/chat-store"
import {
  checkThreadCreation,
  countActiveThreads,
  resumeProjectThreads,
  sendToThread,
  startThread,
  stopThread,
  type ThreadRuntimeDeps,
} from "./thread-runtime"

const NOW = new Date(2026, 8, 29, 15).getTime()

function thread(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: "p1",
    title: id,
    projectRole: "thread",
    projectThread: { coordinatorSessionId: "coord", brief: "b", proposedBy: "coordinator" },
    attachedChild: {
      parentSessionId: "coord",
      lifecycleOwnerSessionId: "coord",
      context: { mode: "none" },
      workspace: "independent",
      status: "staged",
      createdAt: NOW,
    },
    spawnedTask: { mode: "aside", pendingPrompt: "# Do the thing" },
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  } as ChatSession
}

function setup(
  rows: ChatSession[],
  coordinator: ProjectCoordinatorConfig = { enabled: true },
  statuses: Record<string, ChatStatus> = {}
) {
  const table = new Map(rows.map((r) => [r.id, r]))
  const held = new Set<string>()
  const patchChild = (id: string, status: "running" | "interrupted") => {
    const row = table.get(id)!
    table.set(id, { ...row, attachedChild: { ...row.attachedChild!, status } })
  }
  const deps: ThreadRuntimeDeps = {
    getProject: () => ({ id: "p1", coordinator }) as Project,
    getSession: async (id) => table.get(id),
    listThreads: async () => [...table.values()],
    markRunning: jest.fn(async (id) => patchChild(id, "running")),
    interrupt: jest.fn(async (id) => patchChild(id, "interrupted")),
    consumeStagedPrompt: jest.fn(async (id, mode) => {
      table.set(id, { ...table.get(id)!, spawnedTask: { mode } })
    }),
    send: jest.fn(() => true),
    stopTurn: jest.fn(async () => true),
    cancelQueued: jest.fn(() => false),
    hold: jest.fn((id) => held.add(id)),
    release: jest.fn((id) => held.delete(id)),
    statusOf: (id) => statuses[id] ?? "idle",
    now: () => NOW,
  }
  return { deps, table, held }
}

describe("startThread", () => {
  it("holds the thread, submits its brief through send and retires the prompt", async () => {
    const { deps, table, held } = setup([thread("t1")])
    await expect(startThread("t1", "coordinator", deps)).resolves.toEqual({ kind: "started" })
    expect(deps.send).toHaveBeenCalledWith("t1", "# Do the thing")
    expect(held.has("t1")).toBe(true)
    expect(table.get("t1")?.attachedChild?.status).toBe("running")
    expect(table.get("t1")?.spawnedTask).toEqual({ mode: "aside" })
  })

  it("records the start but keeps the brief when the runtime is not mounted", async () => {
    const { deps, table, held } = setup([thread("t1")])
    ;(deps.send as jest.Mock).mockReturnValue(false)
    await expect(startThread("t1", "coordinator", deps)).resolves.toEqual({
      kind: "pending-runtime",
    })
    expect(held.has("t1")).toBe(false)
    expect(table.get("t1")?.attachedChild?.status).toBe("running")
    expect(table.get("t1")?.spawnedTask?.pendingPrompt).toBe("# Do the thing")
  })

  it("stages a coordinator start over the soft limit, but starts a user's", async () => {
    const { deps } = setup(
      [thread("busy", { attachedChild: undefined }), thread("t1")],
      { enabled: true, preferences: { maxConcurrentThreads: 1 } },
      { busy: "streaming" }
    )
    await expect(startThread("t1", "coordinator", deps)).resolves.toEqual({
      kind: "stage",
      reason: "over-concurrency",
    })
    expect(deps.send).not.toHaveBeenCalled()
    await expect(startThread("t1", "user", deps)).resolves.toEqual({ kind: "started" })
  })

  it("refuses when paused and rejects non-startable sessions", async () => {
    const paused = setup([thread("t1")], { enabled: true, paused: { at: 1 } })
    await expect(startThread("t1", "user", paused.deps)).resolves.toEqual({
      kind: "refuse",
      reason: "paused",
    })
    const { deps } = setup([
      thread("started", { spawnedTask: { mode: "aside" } }),
      thread("plain", { projectRole: undefined }),
    ])
    await expect(startThread("missing", "user", deps)).resolves.toMatchObject({ reason: "missing" })
    await expect(startThread("plain", "user", deps)).resolves.toMatchObject({
      reason: "not-thread",
    })
    await expect(startThread("started", "user", deps)).resolves.toMatchObject({
      reason: "already-started",
    })
  })
})

describe("sendToThread", () => {
  it("holds, sends and re-marks a finished thread running", async () => {
    const { deps, table } = setup([
      thread("t1", {
        spawnedTask: { mode: "aside" },
        attachedChild: { ...thread("x").attachedChild!, status: "completed" },
      }),
    ])
    await expect(sendToThread("t1", "Fix CI", deps)).resolves.toBe(true)
    expect(deps.send).toHaveBeenCalledWith("t1", "Fix CI")
    expect(table.get("t1")?.attachedChild?.status).toBe("running")
  })

  it("delivers nothing while paused or when the runtime is missing", async () => {
    const paused = setup([thread("t1")], { enabled: true, paused: { at: 1 } })
    await expect(sendToThread("t1", "x", paused.deps)).resolves.toBe(false)
    const { deps, held } = setup([thread("t1")])
    ;(deps.send as jest.Mock).mockReturnValue(false)
    await expect(sendToThread("t1", "x", deps)).resolves.toBe(false)
    expect(held.size).toBe(0)
  })
})

describe("stopThread", () => {
  it("withdraws the queued turn, stops a live one, interrupts and releases", async () => {
    const { deps, table, held } = setup([thread("t1")], { enabled: true }, { t1: "streaming" })
    held.add("t1")
    await stopThread("t1", deps)
    expect(deps.cancelQueued).toHaveBeenCalledWith("t1")
    expect(deps.stopTurn).toHaveBeenCalledWith("t1")
    expect(deps.interrupt).toHaveBeenCalledWith("t1", "coord")
    expect(table.get("t1")?.attachedChild?.status).toBe("interrupted")
    expect(held.has("t1")).toBe(false)
  })
})

describe("counts and creation admission", () => {
  it("counts active threads and today's creations against the cap", async () => {
    const yesterday = NOW - 24 * 60 * 60 * 1000
    const { deps } = setup(
      [thread("a"), thread("b", { createdAt: yesterday }), thread("c")],
      { enabled: true, preferences: { dailyThreadCap: 2 } },
      { a: "awaiting_approval" }
    )
    await expect(countActiveThreads("coord", deps)).resolves.toBe(1)
    await expect(checkThreadCreation("p1", "coord", deps)).resolves.toEqual({
      kind: "refuse",
      reason: "daily-cap",
    })
  })
})

describe("resumeProjectThreads", () => {
  it("redelivers undelivered briefs and interrupts turns that died with the process", async () => {
    const running = { ...thread("x").attachedChild!, status: "running" as const }
    const { deps, table } = setup(
      [
        thread("undelivered", { attachedChild: running }),
        thread("dead", { attachedChild: running, spawnedTask: { mode: "aside" } }),
        thread("live", { attachedChild: running, spawnedTask: { mode: "aside" } }),
        thread("staged"),
      ],
      { enabled: true },
      { live: "streaming" }
    )
    await resumeProjectThreads("coord", deps)
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(deps.send).toHaveBeenCalledWith("undelivered", "# Do the thing")
    expect(table.get("dead")?.attachedChild?.status).toBe("interrupted")
    expect(table.get("live")?.attachedChild?.status).toBe("running")
    expect(table.get("staged")?.attachedChild?.status).toBe("staged")
  })

  it("leaves undelivered briefs alone while paused", async () => {
    const running = { ...thread("x").attachedChild!, status: "running" as const }
    const { deps } = setup([thread("undelivered", { attachedChild: running })], {
      enabled: true,
      paused: { at: 1 },
    })
    await resumeProjectThreads("coord", deps)
    expect(deps.send).not.toHaveBeenCalled()
  })
})
