// Coverage for session creation, focused on the default-preset auto-apply
// path added in v12 of the preset feature uplift. The non-preset behaviour
// of `createSession` was tested implicitly through the broader app; we
// exercise it directly here so the auto-apply branch can't regress.

import "fake-indexeddb/auto"
import {
  createSession,
  getSession,
  updateSession,
  listSessions,
  listScopedSessions,
  deleteSession,
  bulkDeleteSessions,
  clearBranchSeed,
} from "./sessions"
import { saveSettings } from "./settings"
import { createPreset, setDefaultPreset } from "./prompt-presets"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"
import { createLoop, getLoop, listLoopsBySession } from "./loops"
import { createGoal, listGoalsBySession } from "./goals"

// The /loop cascade tears down backing scheduler tasks via a dynamic
// import — mock the scheduler singleton so no real timing engine spins up.
const schedulerMock = { deleteTask: jest.fn().mockResolvedValue(true) }
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => schedulerMock,
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().promptPresets.clear()
})

describe("createSession — without default preset", () => {
  it("creates a row with caller-supplied fields", async () => {
    const session = await createSession({ title: "Test", model: "claude-y" })
    expect(session.id).toMatch(/^s_/)
    expect(session.title).toBe("Test")
    expect(session.model).toBe("claude-y")
    expect(session.systemPrompt).toBeUndefined()
  })
})

describe("createSession — default preset auto-apply", () => {
  it("copies preset payload onto an empty new session", async () => {
    const preset = await createPreset({
      name: "Default One",
      content: "You are a helpful default.",
      model: "claude-haiku-4-5",
      workingDir: "/auto/path",
    })
    await setDefaultPreset(preset.id)
    const session = await createSession()
    expect(session.systemPrompt).toBe("You are a helpful default.")
    expect(session.model).toBe("claude-haiku-4-5")
    expect(session.workingDir).toBe("/auto/path")
    // usage was recorded
    const fresh = await getDb().promptPresets.get(preset.id)
    expect(fresh?.usageCount).toBe(1)
    expect(typeof fresh?.lastUsedAt).toBe("number")
  })

  it("clearBranchSeed removes only the branchSeed field", async () => {
    const now = Date.now()
    await getDb().sessions.put({
      id: "b1",
      title: "Branch",
      parentSessionId: "p1",
      branchSeed: { kind: "summary", content: "ctx" },
      createdAt: now,
      updatedAt: now,
    })
    await clearBranchSeed("b1")
    const fresh = await getSession("b1")
    expect(fresh?.branchSeed).toBeUndefined()
    // Sibling lineage fields untouched.
    expect(fresh?.parentSessionId).toBe("p1")
  })

  it("does NOT auto-apply when a character is supplied", async () => {
    const preset = await createPreset({
      name: "Default One",
      content: "from preset",
    })
    await setDefaultPreset(preset.id)
    const session = await createSession({ characterId: "char_xx" })
    expect(session.systemPrompt).toBeUndefined()
    const fresh = await getDb().promptPresets.get(preset.id)
    expect(fresh?.usageCount).toBe(0)
  })

  it("does NOT auto-apply when caller already supplied any override", async () => {
    const preset = await createPreset({
      name: "Default One",
      content: "from preset",
      model: "claude-y",
    })
    await setDefaultPreset(preset.id)
    const session = await createSession({ workingDir: "/explicit" })
    expect(session.systemPrompt).toBeUndefined()
    expect(session.model).toBeUndefined()
    expect(session.workingDir).toBe("/explicit")
  })

  it("does NOT throw when no default preset exists", async () => {
    await createPreset({ name: "Plain", content: "x" })
    const session = await createSession()
    expect(session.systemPrompt).toBeUndefined()
  })
})

describe("updateSession + listSessions", () => {
  it("round-trips a patch", async () => {
    const session = await createSession({ title: "Test" })
    await updateSession(session.id, { title: "Renamed" })
    const fetched = await getSession(session.id)
    expect(fetched?.title).toBe("Renamed")
  })

  it("listSessions sorts newest-first by updatedAt", async () => {
    const a = await createSession({ title: "A" })
    await new Promise((r) => setTimeout(r, 5))
    const b = await createSession({ title: "B" })
    const list = await listSessions()
    expect(list[0].id).toBe(b.id)
    expect(list[1].id).toBe(a.id)
  })

  it("round-trips the pinned flag for batch pin/unpin", async () => {
    const session = await createSession({ title: "Pinnable" })
    await updateSession(session.id, { pinned: true })
    expect((await getSession(session.id))?.pinned).toBe(true)
    await updateSession(session.id, { pinned: false })
    expect((await getSession(session.id))?.pinned).toBe(false)
  })
})

describe("bulkDeleteSessions", () => {
  it("removes every session in the list and leaves the rest untouched", async () => {
    const a = await createSession({ title: "A" })
    const b = await createSession({ title: "B" })
    const c = await createSession({ title: "C" })

    await bulkDeleteSessions([a.id, c.id])

    expect(await getSession(a.id)).toBeUndefined()
    expect(await getSession(c.id)).toBeUndefined()
    expect(await getSession(b.id)).toBeDefined()
  })

  it("silently skips ids that are already gone", async () => {
    const a = await createSession({ title: "A" })
    await deleteSession(a.id)
    await expect(bulkDeleteSessions([a.id, "s_missing"])).resolves.toBeUndefined()
  })

  it("is a no-op on an empty array (does not open a transaction)", async () => {
    const a = await createSession({ title: "A" })
    await bulkDeleteSessions([])
    expect(await getSession(a.id)).toBeDefined()
  })
})

describe("deletion tombstones (companion sync v61)", () => {
  it("records session + cascaded message tombstones on deleteSession", async () => {
    const s = await createSession({ title: "X" })
    const db = getDb()
    await db.messages.bulkPut([
      { id: "m1", sessionId: s.id, role: "user", parts: [], createdAt: 1 } as never,
      { id: "m2", sessionId: s.id, role: "user", parts: [], createdAt: 2 } as never,
    ])
    await deleteSession(s.id)

    const sessionTombs = await db.syncTombstones.where("table").equals("sessions").toArray()
    expect(sessionTombs.map((t) => t.id)).toEqual([s.id])
    const messageTombs = await db.syncTombstones.where("table").equals("messages").toArray()
    expect(messageTombs.map((t) => t.id).sort()).toEqual(["m1", "m2"])
  })

  it("records session tombstones on bulkDeleteSessions", async () => {
    const a = await createSession({ title: "A" })
    const b = await createSession({ title: "B" })
    await bulkDeleteSessions([a.id, b.id])
    const ids = (await getDb().syncTombstones.where("table").equals("sessions").toArray())
      .map((t) => t.id)
      .sort()
    expect(ids).toEqual([a.id, b.id].sort())
  })
})

describe("deleteSession — /loop + goal cascade (v79)", () => {
  const LOOP_CONFIG = {
    maxIterations: 100,
    maxTokens: 1_000_000,
    minDelayMs: 60_000,
    maxDelayMs: 3_600_000,
    maxParseFailures: 3,
  }

  it("drops the session's loops and tears down interval scheduler tasks", async () => {
    schedulerMock.deleteTask.mockClear()
    const s = await createSession({ title: "looped" })
    await createLoop({
      id: "lp_int",
      sessionId: s.id,
      mode: "interval",
      rawPrompt: "p",
      safePrompt: "p",
      redactionMapEnc: "",
      isSlashCommand: false,
      status: "active",
      iterations: 0,
      tokensUsed: 0,
      generationId: "g",
      config: LOOP_CONFIG,
      parseFailureCount: 0,
      scheduledTaskId: "task_9",
    })
    await createLoop({
      id: "lp_sp",
      sessionId: s.id,
      mode: "self_paced",
      rawPrompt: "q",
      safePrompt: "q",
      redactionMapEnc: "",
      isSlashCommand: false,
      status: "stopped",
      iterations: 2,
      tokensUsed: 0,
      generationId: "g2",
      config: LOOP_CONFIG,
      parseFailureCount: 0,
    })
    await deleteSession(s.id)
    expect(await getLoop("lp_int")).toBeUndefined()
    expect(await getLoop("lp_sp")).toBeUndefined()
    expect(schedulerMock.deleteTask).toHaveBeenCalledWith("task_9")
    expect(schedulerMock.deleteTask).toHaveBeenCalledTimes(1)
  })

  it("cascades goals on deleteSession (previously orphaned)", async () => {
    const s = await createSession({ title: "goaled" })
    await createGoal({
      id: "g_1",
      sessionId: s.id,
      rawObjective: "o",
      safeObjective: "o",
      redactionMapEnc: "",
      status: "stopped",
      turnsUsed: 1,
      tokensUsed: 0,
      judgeFailureCount: 0,
      config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
      generationId: "gen",
    })
    await deleteSession(s.id)
    expect(await listGoalsBySession(s.id)).toHaveLength(0)
  })

  it("bulkDeleteSessions runs the same cascade per id", async () => {
    schedulerMock.deleteTask.mockClear()
    const a = await createSession({ title: "a" })
    const b = await createSession({ title: "b" })
    await createLoop({
      id: "lp_a",
      sessionId: a.id,
      mode: "interval",
      rawPrompt: "p",
      safePrompt: "p",
      redactionMapEnc: "",
      isSlashCommand: false,
      status: "active",
      iterations: 0,
      tokensUsed: 0,
      generationId: "g",
      config: LOOP_CONFIG,
      parseFailureCount: 0,
      scheduledTaskId: "task_a",
    })
    await bulkDeleteSessions([a.id, b.id])
    expect(await listLoopsBySession(a.id)).toHaveLength(0)
    expect(schedulerMock.deleteTask).toHaveBeenCalledWith("task_a")
  })
})

describe("workspace (project) scoping", () => {
  it("createSession stamps the active project id", async () => {
    await saveSettings({ activeProjectId: "proj-active" })
    const s = await createSession({ title: "scoped" })
    expect(s.projectId).toBe("proj-active")
    expect((await getSession(s.id))?.projectId).toBe("proj-active")
  })

  it("createSession honours an explicit projectId override", async () => {
    await saveSettings({ activeProjectId: "proj-active" })
    const s = await createSession({ title: "explicit", projectId: "proj-other" })
    expect(s.projectId).toBe("proj-other")
  })

  it("listScopedSessions returns only the workspace's sessions, newest-first", async () => {
    await saveSettings({ activeProjectId: "proj-A" })
    const a1 = await createSession({ title: "a1" })
    await new Promise((r) => setTimeout(r, 2))
    const a2 = await createSession({ title: "a2" })
    const b1 = await createSession({ title: "b1", projectId: "proj-B" })

    const scopedA = await listScopedSessions("proj-A")
    expect(scopedA.map((s) => s.id)).toEqual([a2.id, a1.id])
    expect(scopedA.some((s) => s.id === b1.id)).toBe(false)

    // Defaulting to the active project yields the same result.
    expect((await listScopedSessions()).map((s) => s.id)).toEqual([a2.id, a1.id])
    // The unscoped escape hatch still sees every workspace.
    expect((await listSessions()).map((s) => s.id).sort()).toEqual([a1.id, a2.id, b1.id].sort())
  })
})
