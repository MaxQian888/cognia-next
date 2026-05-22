// CRUD coverage for the characters table — list/get/create/update/delete
// plus the duplicate path and idempotent built-in seeder. ADR-0030 added
// overlay-aware paths exercised below.

import "fake-indexeddb/auto"
import {
  createCharacter,
  deleteCharacter,
  duplicateCharacter,
  getCharacter,
  listCharacters,
  listCharactersByIds,
  projectOverlayCharacter,
  resolveCharacterById,
  seedBuiltInCharacters,
  updateCharacter,
} from "./characters"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  __resetCharacterPacksForTesting,
  registerCharacterPack,
} from "@/lib/plugin/registries/character-pack-registry"
import type {
  PluginCharacterDef,
  PluginCharacterPackDef,
} from "@/types/plugin/plugin-character-pack"

function makeOverlayChar(
  localId: string,
  overrides: Partial<PluginCharacterDef> = {}
): PluginCharacterDef {
  return {
    localId,
    name: `Overlay ${localId}`,
    avatarColor: "oklch(0.7 0.15 250)",
    systemPrompt: `Overlay prompt for ${localId}`,
    ...overrides,
  }
}

function makeOverlayPack(
  id: string,
  characters: PluginCharacterDef[],
  overrides: Partial<PluginCharacterPackDef> = {}
): PluginCharacterPackDef {
  return {
    id,
    name: `Pack ${id}`,
    version: "1.0.0",
    characters,
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().characters.clear()
  __resetCharacterPacksForTesting()
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

// ============================================================================
// ADR-0030 — Plugin Character Pack overlay paths
// ============================================================================

describe("projectOverlayCharacter", () => {
  it("builds a synthetic Character from a pack + character + pluginId", () => {
    const pack = makeOverlayPack("workplace", [makeOverlayChar("alice")])
    const projected = projectOverlayCharacter(pack, pack.characters[0], "plug-a")
    expect(projected.id).toBe("cognia-pack:plug-a:workplace:alice")
    expect(projected.name).toBe("Overlay alice")
    expect(projected.isBuiltIn).toBe(false)
    expect(projected.sourcePluginId).toBe("plug-a")
    expect(projected.sourcePackId).toBe("workplace")
    expect(projected.createdAt).toBe(0)
    expect(projected.updatedAt).toBe(0)
  })

  it("uses an empty plugin segment for anonymous (local-imported) packs", () => {
    const pack = makeOverlayPack("imported", [makeOverlayChar("alice")])
    const projected = projectOverlayCharacter(pack, pack.characters[0], undefined)
    expect(projected.id).toBe("cognia-pack::imported:alice")
    expect(projected.sourcePluginId).toBeUndefined()
  })
})

describe("listCharacters with overlay union", () => {
  it("merges Dexie rows and plugin-overlay rows by name", async () => {
    await createCharacter({ name: "Charlie", systemPrompt: "x" })
    registerCharacterPack(
      "workplace",
      makeOverlayPack("workplace", [
        makeOverlayChar("alice", { name: "Alice" }),
        makeOverlayChar("bob", { name: "Bob" }),
      ]),
      { pluginId: "plug-a" }
    )

    const rows = await listCharacters()
    expect(rows.map((r) => r.name)).toEqual(["Alice", "Bob", "Charlie"])
    const overlay = rows.find((r) => r.name === "Alice")
    expect(overlay?.id).toBe("cognia-pack:plug-a:workplace:alice")
    expect(overlay?.sourcePluginId).toBe("plug-a")
  })

  it("returns Dexie row when an overlay synthetic id is shadowed by a same-id Dexie row", async () => {
    // Defensive belt-and-braces. The namespace makes this impossible in
    // practice (cognia-pack: prefix would not pass through createCharacter's
    // newId() generator), but if someone manually inserts a Dexie row with
    // a colliding id the union still prefers Dexie.
    const collidingId = "cognia-pack:plug-a:workplace:alice"
    const now = Date.now()
    await getDb().characters.put({
      id: collidingId,
      name: "Manual Override",
      avatarColor: "oklch(0.5 0.1 0)",
      systemPrompt: "x",
      createdAt: now,
      updatedAt: now,
    })
    registerCharacterPack("workplace", makeOverlayPack("workplace", [makeOverlayChar("alice")]), {
      pluginId: "plug-a",
    })

    const rows = await listCharacters()
    const found = rows.find((r) => r.id === collidingId)
    expect(found?.name).toBe("Manual Override")
  })
})

describe("resolveCharacterById", () => {
  it("returns the Dexie row when id is a Dexie id", async () => {
    const c = await createCharacter({ name: "User Char", systemPrompt: "x" })
    const resolved = await resolveCharacterById(c.id)
    expect(resolved?.id).toBe(c.id)
    expect(resolved?.name).toBe("User Char")
  })

  it("falls through to overlay registry when id is a synthetic overlay id", async () => {
    registerCharacterPack("workplace", makeOverlayPack("workplace", [makeOverlayChar("alice")]), {
      pluginId: "plug-a",
    })
    const resolved = await resolveCharacterById("cognia-pack:plug-a:workplace:alice")
    expect(resolved?.name).toBe("Overlay alice")
    expect(resolved?.sourcePluginId).toBe("plug-a")
  })

  it("returns undefined when overlay id resolves to nothing (plugin disabled)", async () => {
    const resolved = await resolveCharacterById("cognia-pack:plug-a:workplace:alice")
    expect(resolved).toBeUndefined()
  })

  it("returns undefined for unknown Dexie ids and treats non-cognia-pack: ids as Dexie-only", async () => {
    expect(await resolveCharacterById("char_unknown")).toBeUndefined()
    expect(await resolveCharacterById("anything-else")).toBeUndefined()
  })
})

describe("listCharactersByIds with overlay ids", () => {
  it("resolves overlay ids alongside Dexie ids, preserving caller order", async () => {
    const a = await createCharacter({ name: "A", systemPrompt: "x" })
    registerCharacterPack("workplace", makeOverlayPack("workplace", [makeOverlayChar("alice")]), {
      pluginId: "plug-a",
    })
    const overlayId = "cognia-pack:plug-a:workplace:alice"
    const out = await listCharactersByIds([overlayId, "char_missing", a.id])
    expect(out.map((r) => r.id)).toEqual([overlayId, a.id])
  })
})

describe("deleteCharacter rejects overlay ids", () => {
  it("throws a descriptive error for synthetic overlay ids", async () => {
    registerCharacterPack("workplace", makeOverlayPack("workplace", [makeOverlayChar("alice")]), {
      pluginId: "plug-a",
    })
    await expect(deleteCharacter("cognia-pack:plug-a:workplace:alice")).rejects.toThrow(
      /Plugin-overlay characters cannot be deleted/
    )
  })
})

describe("updateCharacter rejects overlay ids", () => {
  it("throws when called with a synthetic overlay id", async () => {
    await expect(
      updateCharacter("cognia-pack:plug-a:workplace:alice", { description: "x" })
    ).rejects.toThrow(/Plugin-overlay characters are read-only/)
  })
})

describe("duplicateCharacter with overlay source", () => {
  it("clones an overlay character into a new Dexie row with source attribution", async () => {
    registerCharacterPack(
      "workplace",
      makeOverlayPack("workplace", [makeOverlayChar("alice")], { version: "1.2.3" }),
      { pluginId: "plug-a" }
    )
    const overlayId = "cognia-pack:plug-a:workplace:alice"
    const copy = await duplicateCharacter(overlayId)

    expect(copy.id).toMatch(/^char_/)
    expect(copy.id).not.toBe(overlayId)
    expect(copy.name).toBe("Overlay alice (copy)")
    expect(copy.isBuiltIn).toBe(false)
    expect(copy.systemPrompt).toBe("Overlay prompt for alice")
    expect(copy.sourcePluginId).toBe("plug-a")
    expect(copy.sourcePackId).toBe("workplace")
    expect(copy.clonedFromPackCharacterId).toBe(overlayId)
    expect(copy.packVersionAtClone).toBe("1.2.3")

    // The clone is a real Dexie row that survives plugin disable.
    const reFetched = await getCharacter(copy.id)
    expect(reFetched?.sourcePluginId).toBe("plug-a")
  })

  it("throws when the overlay id no longer resolves (plugin disabled)", async () => {
    await expect(duplicateCharacter("cognia-pack:plug-a:workplace:alice")).rejects.toThrow(
      /not found/
    )
  })

  it("leaves source-attribution fields untouched when cloning a Dexie row", async () => {
    const source = await createCharacter({ name: "User Char", systemPrompt: "x" })
    const copy = await duplicateCharacter(source.id)
    expect(copy.sourcePluginId).toBeUndefined()
    expect(copy.sourcePackId).toBeUndefined()
    expect(copy.clonedFromPackCharacterId).toBeUndefined()
    expect(copy.packVersionAtClone).toBeUndefined()
  })
})
