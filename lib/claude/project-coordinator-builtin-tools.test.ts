import type { ChatSession } from "@cognia/agent-config-types"
import {
  MAX_PROPOSED_THREADS,
  PROJECT_COORDINATOR_TOOL_NAMES as T,
  PROJECT_THREAD_TOOL_NAMES,
  buildProjectCoordinatorManifestEntries,
  buildProjectThreadManifestEntries,
  isProjectCoordinatorBuiltinTool,
  runProjectCoordinatorBuiltinTool,
  type ProjectCoordinatorToolDeps,
} from "./project-coordinator-builtin-tools"

const brief = {
  title: "Fix login",
  tldr: "Login flakes.",
  situation: "Times out.",
  code_locations: ["a.ts:1"],
  solution: "Stub it.",
  caveats: [],
}

const coordinator = {
  id: "coord",
  projectId: "p1",
  projectRole: "coordinator",
  title: "C",
} as ChatSession
const own = {
  id: "t1",
  projectId: "p1",
  title: "Fix login",
  projectRole: "thread",
  projectThread: { coordinatorSessionId: "coord", brief: "b", proposedBy: "coordinator" },
  attachedChild: {
    parentSessionId: "coord",
    lifecycleOwnerSessionId: "coord",
    context: { mode: "none" },
    workspace: "independent",
    status: "completed",
    createdAt: 1,
    result: { summary: "Done", completedAt: 2 },
  },
  executionContext: { branch: "thread/fix-login" },
} as ChatSession
const foreign = {
  ...own,
  id: "t9",
  projectThread: { ...own.projectThread!, coordinatorSessionId: "other" },
} as ChatSession

function deps(overrides: Partial<ProjectCoordinatorToolDeps> = {}): ProjectCoordinatorToolDeps {
  const rows = new Map([coordinator, own, foreign].map((s) => [s.id, s]))
  return {
    getSession: async (id) => rows.get(id),
    listThreads: async () => [own],
    statusOf: () => "idle",
    checkCreation: jest.fn(async () => ({ kind: "allow" as const })),
    createThread: jest.fn(async (input) => ({ ...own, id: "t-new", title: input.brief.title })),
    startThread: jest.fn(async () => ({ kind: "started" as const })),
    sendToThread: jest.fn(async () => true),
    stopThread: jest.fn(async () => undefined),
    resolveThread: jest.fn(async () => true),
    listMessages: async () => [
      { id: "1", role: "assistant", parts: [{ type: "text", text: "first" }] },
      { id: "2", role: "user", parts: [{ type: "text", text: "u" }] },
      { id: "3", role: "assistant", parts: [{ type: "text", text: "second" }] },
    ],
    remember: jest.fn(async () => ({ ok: true as const, scope: "workspace" as const })),
    setPreference: jest.fn(() => ({ ok: true as const, patch: {} })),
    declareThreadState: jest.fn(async () => undefined),
    gate: () => true,
    assistantText: (m) => (m?.parts ?? []).map((p) => ("text" in p ? p.text : "")).join(""),
    ...overrides,
  }
}

const run = (name: string, args: Record<string, unknown>, d = deps(), sessionId = "coord") =>
  runProjectCoordinatorBuiltinTool(name, args, d, { sessionId })

describe("manifest", () => {
  it("declares every coordinator tool and the thread tool with object schemas", () => {
    const coordinatorNames = buildProjectCoordinatorManifestEntries().map((e) => e.name)
    expect(coordinatorNames.sort()).toEqual(Object.values(T).sort())
    expect(buildProjectThreadManifestEntries().map((e) => e.name)).toEqual([
      PROJECT_THREAD_TOOL_NAMES.reportToCoordinator,
    ])
    const spawn = buildProjectCoordinatorManifestEntries().find((e) => e.name === T.spawnThread)!
    expect(spawn.jsonSchema.properties).not.toHaveProperty("mode")
    expect(spawn.jsonSchema.properties).toHaveProperty("root_id")
    expect(isProjectCoordinatorBuiltinTool("spawn_thread")).toBe(true)
    expect(isProjectCoordinatorBuiltinTool("report_to_coordinator")).toBe(true)
    expect(isProjectCoordinatorBuiltinTool("spawn_task")).toBe(false)
  })
})

describe("caller checks", () => {
  it("refuses coordinator tools from any other session and unknown names", async () => {
    await expect(run(T.listThreads, {}, deps(), "t1")).resolves.toMatchObject({ ok: false })
    await expect(run("nope", {})).resolves.toMatchObject({ ok: false })
    await expect(
      runProjectCoordinatorBuiltinTool(T.listThreads, {}, undefined, { sessionId: "coord" })
    ).resolves.toMatchObject({ ok: false })
  })

  it("refuses a thread that belongs to another coordinator", async () => {
    await expect(run(T.stopThread, { thread_id: "t9" })).resolves.toEqual({
      ok: false,
      error: "No thread t9 in this project",
    })
  })

  it("turns a thrown host error into a tool error", async () => {
    const d = deps({ stopThread: jest.fn(async () => Promise.reject(new Error("boom"))) })
    await expect(run(T.stopThread, { thread_id: "t1" }, d)).resolves.toEqual({
      ok: false,
      error: "boom",
    })
  })
})

describe("spawn_thread", () => {
  it("creates and starts a thread from a spawn_task-shaped brief", async () => {
    const d = deps()
    await expect(run(T.spawnThread, { ...brief, root_id: "docs" }, d)).resolves.toEqual({
      ok: true,
      threadId: "t-new",
      title: "Fix login",
      status: "started",
    })
    expect(d.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        coordinatorSessionId: "coord",
        rootId: "docs",
        proposedBy: "coordinator",
        brief: expect.objectContaining({ title: "Fix login", codeLocations: ["a.ts:1"] }),
      })
    )
    expect(d.startThread).toHaveBeenCalledWith("t-new", "coordinator")
  })

  it("creates staged on request, reports staging, and refuses over hard limits", async () => {
    const d = deps()
    await expect(run(T.spawnThread, { ...brief, start: false }, d)).resolves.toMatchObject({
      status: "staged",
    })
    expect(d.startThread).not.toHaveBeenCalled()

    const staged = deps({
      startThread: jest.fn(async () => ({
        kind: "stage" as const,
        reason: "propose-first" as const,
      })),
    })
    await expect(run(T.spawnThread, brief, staged)).resolves.toMatchObject({
      status: "staged",
      reason: "propose-first",
    })

    const capped = deps({
      checkCreation: jest.fn(async () => ({
        kind: "refuse" as const,
        reason: "daily-cap" as const,
      })),
    })
    await expect(run(T.spawnThread, brief, capped)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("daily thread limit"),
    })
    expect(capped.createThread).not.toHaveBeenCalled()
  })

  it("validates the brief", async () => {
    await expect(run(T.spawnThread, { ...brief, tldr: "" })).resolves.toMatchObject({
      ok: false,
      error: "tldr must be a non-empty string",
    })
  })
})

describe("propose_threads", () => {
  it("returns parsed proposals without creating anything", async () => {
    const d = deps()
    const result = (await run(
      T.proposeThreads,
      { threads: [brief, { ...brief, root_id: "r2" }] },
      d
    )) as {
      proposals: Array<{ title: string; rootId?: string }>
    }
    expect(result.proposals).toHaveLength(2)
    expect(result.proposals[1].rootId).toBe("r2")
    expect(d.createThread).not.toHaveBeenCalled()
  })

  it("rejects empty, oversized, invalid or PII-bearing proposals", async () => {
    await expect(run(T.proposeThreads, { threads: [] })).resolves.toMatchObject({ ok: false })
    await expect(
      run(T.proposeThreads, { threads: Array(MAX_PROPOSED_THREADS + 1).fill(brief) })
    ).resolves.toMatchObject({ ok: false })
    await expect(run(T.proposeThreads, { threads: [{ title: "x" }] })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("threads[0]"),
    })
    await expect(
      run(T.proposeThreads, { threads: [brief] }, deps({ gate: () => false }))
    ).resolves.toMatchObject({ ok: false })
  })
})

describe("thread operations", () => {
  it("messages, starts, stops and resolves an own thread", async () => {
    const d = deps()
    await expect(run(T.messageThread, { thread_id: "t1", message: "next" }, d)).resolves.toEqual({
      ok: true,
      threadId: "t1",
      status: "sent",
    })
    expect(d.sendToThread).toHaveBeenCalledWith("t1", "next")
    await expect(run(T.startThread, { thread_id: "t1" }, d)).resolves.toMatchObject({
      status: "started",
    })
    await expect(run(T.stopThread, { thread_id: "t1" }, d)).resolves.toMatchObject({
      status: "interrupted",
    })
    await expect(run(T.resolveThread, { thread_id: "t1" }, d)).resolves.toMatchObject({
      status: "resolved",
    })
  })

  it("reports an undeliverable or gated message as an error", async () => {
    await expect(
      run(
        T.messageThread,
        { thread_id: "t1", message: "x" },
        deps({ sendToThread: async () => false })
      )
    ).resolves.toMatchObject({ ok: false })
    await expect(
      run(T.messageThread, { thread_id: "t1", message: "x" }, deps({ gate: () => false }))
    ).resolves.toMatchObject({ ok: false })
    await expect(run(T.messageThread, { thread_id: "t1" })).resolves.toMatchObject({ ok: false })
  })

  it("lists and reads threads", async () => {
    await expect(run(T.listThreads, {})).resolves.toEqual({
      ok: true,
      threads: [
        {
          id: "t1",
          title: "Fix login",
          status: "idle",
          lifecycle: "completed",
          branch: "thread/fix-login",
          resolved: false,
          lastReport: "Done",
        },
      ],
    })
    await expect(run(T.readThreadReport, { thread_id: "t1", full: true })).resolves.toMatchObject({
      result: "Done",
      recentAssistantMessages: ["first", "second"],
    })
  })
})

describe("memory and preferences", () => {
  it("remembers a project note in workspace scope", async () => {
    const d = deps()
    await expect(run(T.rememberProjectNote, { text: "Target main" }, d)).resolves.toEqual({
      ok: true,
      scope: "workspace",
    })
    expect(d.remember).toHaveBeenCalledWith({ text: "Target main", sessionId: "coord" })
    await expect(
      run(
        T.rememberProjectNote,
        { text: "x" },
        deps({ remember: async () => ({ ok: false as const, reason: "disabled" as const }) })
      )
    ).resolves.toEqual({ ok: false, error: "Not remembered: disabled" })
  })

  it("sets a preference through the host", async () => {
    const d = deps()
    await expect(
      run(T.setProjectPreference, { key: "max_concurrent_threads", value: 2 }, d)
    ).resolves.toEqual({ ok: true, key: "max_concurrent_threads", value: 2 })
    expect(d.setPreference).toHaveBeenCalledWith("p1", "max_concurrent_threads", 2)
    await expect(
      run(
        T.setProjectPreference,
        { key: "x", value: 1 },
        deps({ setPreference: () => ({ ok: false as const, error: "bad key" }) })
      )
    ).resolves.toEqual({ ok: false, error: "bad key" })
  })
})

describe("report_to_coordinator", () => {
  it("records a thread's declared state, only from a thread", async () => {
    const d = deps()
    await expect(
      run(PROJECT_THREAD_TOOL_NAMES.reportToCoordinator, { state: "ready-for-review" }, d, "t1")
    ).resolves.toEqual({ ok: true, state: "ready-for-review" })
    expect(d.declareThreadState).toHaveBeenCalledWith(own, "ready-for-review")
    await expect(
      run(PROJECT_THREAD_TOOL_NAMES.reportToCoordinator, { state: "done" }, d, "t1")
    ).resolves.toMatchObject({ ok: false })
    await expect(
      run(PROJECT_THREAD_TOOL_NAMES.reportToCoordinator, { state: "landing" }, d, "coord")
    ).resolves.toMatchObject({ ok: false })
  })
})
