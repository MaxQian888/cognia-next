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
  deleteSession,
  bulkDeleteSessions,
} from "./sessions"
import { createPreset, setDefaultPreset } from "./prompt-presets"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"

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
