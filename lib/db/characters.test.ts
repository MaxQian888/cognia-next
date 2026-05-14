// CRUD coverage for the characters table — list/get/create/update/delete
// plus the duplicate path and idempotent built-in seeder.

import "fake-indexeddb/auto"
import {
  createCharacter,
  deleteCharacter,
  duplicateCharacter,
  getCharacter,
  listCharacters,
  listCharactersByIds,
  seedBuiltInCharacters,
  updateCharacter,
} from "./characters"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().characters.clear()
})

describe("createCharacter", () => {
  it("inserts a row with sensible defaults", async () => {
    const c = await createCharacter({ name: "  Hero  ", systemPrompt: "be heroic" })
    expect(c.id).toMatch(/^char_/)
    expect(c.name).toBe("Hero")
    expect(c.avatarColor).toBe("oklch(0.7 0.15 250)")
    expect(c.createdAt).toBe(c.updatedAt)
    const fetched = await getCharacter(c.id)
    expect(fetched?.name).toBe("Hero")
  })

  it("falls back to 'Untitled character' on empty name", async () => {
    const c = await createCharacter({ name: "   ", systemPrompt: "x" })
    expect(c.name).toBe("Untitled character")
  })

  it("preserves caller-supplied avatar / model / mcp / skills", async () => {
    const c = await createCharacter({
      name: "Nia",
      systemPrompt: "x",
      avatarColor: "oklch(0.5 0.1 0)",
      avatarEmoji: "🦊",
      model: "claude-haiku",
      permissionMode: "default",
      allowedTools: ["fs"],
      disallowedTools: ["bash"],
      mcpServerIds: ["mcp_1"],
      skillIds: ["skill_1"],
      workingDir: "/tmp",
      description: "small fox",
    })
    expect(c.avatarEmoji).toBe("🦊")
    expect(c.model).toBe("claude-haiku")
    expect(c.allowedTools).toEqual(["fs"])
    expect(c.workingDir).toBe("/tmp")
    expect(c.description).toBe("small fox")
  })
})

describe("listCharacters", () => {
  it("returns rows ordered by name ascending", async () => {
    await createCharacter({ name: "Charlie", systemPrompt: "x" })
    await createCharacter({ name: "Alpha", systemPrompt: "x" })
    await createCharacter({ name: "Bravo", systemPrompt: "x" })
    const rows = await listCharacters()
    expect(rows.map((r) => r.name)).toEqual(["Alpha", "Bravo", "Charlie"])
  })
})

describe("listCharactersByIds", () => {
  it("returns empty array for empty input", async () => {
    expect(await listCharactersByIds([])).toEqual([])
  })

  it("preserves caller order and drops missing ids", async () => {
    const a = await createCharacter({ name: "A", systemPrompt: "x" })
    const b = await createCharacter({ name: "B", systemPrompt: "x" })
    const out = await listCharactersByIds([b.id, "char_missing", a.id])
    expect(out.map((r) => r.id)).toEqual([b.id, a.id])
  })
})

describe("updateCharacter", () => {
  it("merges patch and bumps updatedAt", async () => {
    const c = await createCharacter({ name: "A", systemPrompt: "x" })
    const before = c.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await updateCharacter(c.id, { description: "patched" })
    const fresh = await getCharacter(c.id)
    expect(fresh?.description).toBe("patched")
    expect(fresh?.updatedAt).toBeGreaterThan(before)
  })
})

describe("deleteCharacter", () => {
  it("removes a user-created row", async () => {
    const c = await createCharacter({ name: "A", systemPrompt: "x" })
    await deleteCharacter(c.id)
    expect(await getCharacter(c.id)).toBeUndefined()
  })

  it("rejects deletion of built-ins", async () => {
    await seedBuiltInCharacters()
    const builtIn = (await listCharacters()).find((c) => c.isBuiltIn)!
    await expect(deleteCharacter(builtIn.id)).rejects.toThrow(/Built-in/)
  })

  it("is a no-op on missing ids", async () => {
    await expect(deleteCharacter("char_missing")).resolves.toBeUndefined()
  })
})

describe("duplicateCharacter", () => {
  it("clones the row but resets isBuiltIn and renames", async () => {
    await seedBuiltInCharacters()
    const builtIn = (await listCharacters()).find((c) => c.isBuiltIn)!
    const copy = await duplicateCharacter(builtIn.id)
    expect(copy.id).not.toBe(builtIn.id)
    expect(copy.name).toBe(`${builtIn.name} (copy)`)
    expect(copy.isBuiltIn).toBe(false)
    expect(copy.systemPrompt).toBe(builtIn.systemPrompt)
  })

  it("throws when the source is missing", async () => {
    await expect(duplicateCharacter("char_missing")).rejects.toThrow(/not found/)
  })
})

describe("seedBuiltInCharacters", () => {
  it("inserts the canonical 6 built-ins idempotently", async () => {
    await seedBuiltInCharacters()
    const first = await listCharacters()
    expect(first.filter((c) => c.isBuiltIn).length).toBe(6)
    // re-seed: count should remain 6
    await seedBuiltInCharacters()
    const second = await listCharacters()
    expect(second.filter((c) => c.isBuiltIn).length).toBe(6)
  })

  it("includes the Goal Tracker character with acceptEdits permission mode", async () => {
    await seedBuiltInCharacters()
    const goalTracker = await getCharacter("char_builtin_goal_tracker")
    expect(goalTracker).toBeDefined()
    expect(goalTracker?.name).toBe("Goal Tracker")
    expect(goalTracker?.isBuiltIn).toBe(true)
    expect(goalTracker?.permissionMode).toBe("acceptEdits")
    expect(goalTracker?.systemPrompt).toMatch(/outcome-driven agent/i)
  })
})
