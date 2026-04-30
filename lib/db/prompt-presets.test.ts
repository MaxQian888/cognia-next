// Coverage for the prompt-presets CRUD layer + built-in seeder. Uses
// fake-indexeddb so the real Dexie indexes / transactions / upgrade hook
// run against an in-memory IDB.

import "fake-indexeddb/auto"
import {
  clearDefaultPreset,
  createPreset,
  deletePreset,
  duplicatePreset,
  getDefaultPreset,
  getPreset,
  getPresetsByIds,
  isBuiltInPreset,
  listPresets,
  recordPresetUsage,
  reorderPresets,
  resetPresetsToBuiltIns,
  seedBuiltInPresets,
  setDefaultPreset,
  togglePresetFavorite,
  updatePreset,
} from "./prompt-presets"
import { BUILT_IN_PRESET_IDS, buildBuiltInPresets } from "./preset-built-ins"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  // Wipe so each test starts from a clean slate (the seeder still runs
  // automatically; we explicitly clear here for tests that don't want
  // built-ins around).
  await getDb().promptPresets.clear()
})

describe("createPreset", () => {
  it("inserts a row with sensible defaults", async () => {
    const preset = await createPreset({
      name: "  Summariser  ",
      content: "Summarise.",
    })
    expect(preset.id).toMatch(/^p_/)
    expect(preset.name).toBe("Summariser")
    expect(preset.isBuiltIn).toBe(false)
    expect(preset.isFavorite).toBe(false)
    expect(preset.usageCount).toBe(0)
    expect(preset.sortOrder).toBe(0)
    const fetched = await getPreset(preset.id)
    expect(fetched?.name).toBe("Summariser")
  })

  it("falls back to 'Untitled preset' when name is empty", async () => {
    const preset = await createPreset({ name: "   ", content: "x" })
    expect(preset.name).toBe("Untitled preset")
  })

  it("auto-increments sortOrder", async () => {
    const a = await createPreset({ name: "A", content: "x" })
    const b = await createPreset({ name: "B", content: "y" })
    expect(b.sortOrder).toBe((a.sortOrder ?? 0) + 1)
  })

  it("routes through setDefaultPreset when isDefault is true", async () => {
    const a = await createPreset({ name: "A", content: "x" })
    const b = await createPreset({ name: "B", content: "y", isDefault: true })
    const aFresh = await getPreset(a.id)
    const bFresh = await getPreset(b.id)
    expect(aFresh?.isDefault).toBe(false)
    expect(bFresh?.isDefault).toBe(true)
  })
})

describe("listPresets", () => {
  it("orders by sortOrder asc, then updatedAt desc", async () => {
    const a = await createPreset({ name: "A", content: "x" })
    const b = await createPreset({ name: "B", content: "y" })
    // Tick clock for B to leapfrog A on updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await updatePreset(b.id, { name: "B!" })
    const all = await listPresets()
    expect(all.map((p) => p.id)).toEqual([a.id, b.id])
  })
})

describe("updatePreset", () => {
  it("rejects edits to built-in presets", async () => {
    await seedBuiltInPresets()
    const builtIn = (await listPresets()).find((p) => p.isBuiltIn)!
    await expect(updatePreset(builtIn.id, { name: "x" })).rejects.toThrow(/Built-in/)
  })

  it("strips fields that aren't editable but persists patch", async () => {
    const preset = await createPreset({ name: "A", content: "x" })
    await updatePreset(preset.id, { description: "new desc" })
    const updated = await getPreset(preset.id)
    expect(updated?.description).toBe("new desc")
    expect(updated?.id).toBe(preset.id)
  })

  it("routes isDefault=true through setDefaultPreset", async () => {
    const a = await createPreset({ name: "A", content: "x" })
    const b = await createPreset({ name: "B", content: "y" })
    await updatePreset(a.id, { isDefault: true })
    await updatePreset(b.id, { isDefault: true })
    const aFresh = await getPreset(a.id)
    const bFresh = await getPreset(b.id)
    expect(aFresh?.isDefault).toBe(false)
    expect(bFresh?.isDefault).toBe(true)
  })

  it("throws if preset is missing", async () => {
    await expect(updatePreset("nope", { name: "x" })).rejects.toThrow(/not found/)
  })
})

describe("deletePreset", () => {
  it("removes a user preset", async () => {
    const preset = await createPreset({ name: "A", content: "x" })
    await deletePreset(preset.id)
    expect(await getPreset(preset.id)).toBeUndefined()
  })

  it("rejects deletion of built-ins", async () => {
    await seedBuiltInPresets()
    const builtIn = (await listPresets()).find((p) => p.isBuiltIn)!
    await expect(deletePreset(builtIn.id)).rejects.toThrow(/Built-in/)
  })

  it("is a no-op for missing ids", async () => {
    await expect(deletePreset("nope")).resolves.toBeUndefined()
  })
})

describe("duplicatePreset", () => {
  it("clones every field but resets usage / id / built-in flag", async () => {
    await seedBuiltInPresets()
    const builtIn = (await listPresets()).find((p) => p.isBuiltIn)!
    const copy = await duplicatePreset(builtIn.id)
    expect(copy.id).not.toBe(builtIn.id)
    expect(copy.id).toMatch(/^p_/)
    expect(copy.isBuiltIn).toBe(false)
    expect(copy.isDefault).toBe(false)
    expect(copy.usageCount).toBe(0)
    expect(copy.lastUsedAt).toBeUndefined()
    expect(copy.name).toBe(`${builtIn.name} (Copy)`)
    expect(copy.content).toBe(builtIn.content)
    expect(copy.color).toBe(builtIn.color)
  })

  it("throws when source is missing", async () => {
    await expect(duplicatePreset("nope")).rejects.toThrow(/not found/)
  })
})

describe("setDefaultPreset / clearDefaultPreset", () => {
  it("enforces single-default invariant", async () => {
    const a = await createPreset({ name: "A", content: "x" })
    const b = await createPreset({ name: "B", content: "y" })
    const c = await createPreset({ name: "C", content: "z" })
    await setDefaultPreset(a.id)
    await setDefaultPreset(b.id)
    const all = await listPresets()
    const defaults = all.filter((p) => p.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].id).toBe(b.id)
    expect(c.isDefault).toBeFalsy()
  })

  it("clearDefaultPreset wipes the flag", async () => {
    const a = await createPreset({ name: "A", content: "x" })
    await setDefaultPreset(a.id)
    expect((await getDefaultPreset())?.id).toBe(a.id)
    await clearDefaultPreset()
    expect(await getDefaultPreset()).toBeUndefined()
  })

  it("setDefaultPreset throws when target is missing", async () => {
    await expect(setDefaultPreset("nope")).rejects.toThrow(/not found/)
  })

  it("clearDefaultPreset is a no-op when nothing is default", async () => {
    await clearDefaultPreset()
    expect(await getDefaultPreset()).toBeUndefined()
  })
})

describe("getDefaultPreset", () => {
  it("returns undefined when none marked default", async () => {
    await createPreset({ name: "A", content: "x" })
    expect(await getDefaultPreset()).toBeUndefined()
  })
})

describe("togglePresetFavorite", () => {
  it("flips the favorite flag", async () => {
    const a = await createPreset({ name: "A", content: "x" })
    await togglePresetFavorite(a.id)
    expect((await getPreset(a.id))?.isFavorite).toBe(true)
    await togglePresetFavorite(a.id)
    expect((await getPreset(a.id))?.isFavorite).toBe(false)
  })

  it("throws on missing preset", async () => {
    await expect(togglePresetFavorite("nope")).rejects.toThrow(/not found/)
  })
})

describe("reorderPresets", () => {
  it("persists the new sortOrder", async () => {
    const a = await createPreset({ name: "A", content: "x" })
    const b = await createPreset({ name: "B", content: "y" })
    const c = await createPreset({ name: "C", content: "z" })
    await reorderPresets([c.id, a.id, b.id])
    const ordered = await listPresets()
    expect(ordered.map((p) => p.id)).toEqual([c.id, a.id, b.id])
  })

  it("ignores ids missing from the supplied list", async () => {
    const a = await createPreset({ name: "A", content: "x" })
    const b = await createPreset({ name: "B", content: "y" })
    await reorderPresets([b.id])
    const aFresh = await getPreset(a.id)
    const bFresh = await getPreset(b.id)
    expect(bFresh?.sortOrder).toBe(0)
    expect(aFresh?.sortOrder).toBe(a.sortOrder)
  })

  it("is a no-op for an empty list", async () => {
    await expect(reorderPresets([])).resolves.toBeUndefined()
  })
})

describe("recordPresetUsage", () => {
  it("bumps usageCount and stamps lastUsedAt", async () => {
    const a = await createPreset({ name: "A", content: "x" })
    await recordPresetUsage(a.id)
    const fresh = await getPreset(a.id)
    expect(fresh?.usageCount).toBe(1)
    expect(typeof fresh?.lastUsedAt).toBe("number")
  })

  it("is a no-op for missing presets", async () => {
    await expect(recordPresetUsage("nope")).resolves.toBeUndefined()
  })
})

describe("getPresetsByIds", () => {
  it("preserves caller order, drops missing", async () => {
    const a = await createPreset({ name: "A", content: "x" })
    const b = await createPreset({ name: "B", content: "y" })
    const out = await getPresetsByIds([b.id, "nope", a.id])
    expect(out.map((p) => p.id)).toEqual([b.id, a.id])
  })

  it("returns [] for empty input", async () => {
    expect(await getPresetsByIds([])).toEqual([])
  })
})

describe("seedBuiltInPresets / resetPresetsToBuiltIns", () => {
  it("seeds the canonical 12 built-ins", async () => {
    await seedBuiltInPresets()
    const all = await listPresets()
    expect(all.filter((p) => p.isBuiltIn).length).toBe(12)
    for (const id of BUILT_IN_PRESET_IDS) {
      expect(all.find((p) => p.id === id)).toBeDefined()
    }
  })

  it("re-seeding is idempotent and refreshes seed data", async () => {
    await seedBuiltInPresets()
    const before = await listPresets()
    // Mutate a built-in directly via Dexie (simulates older seed data).
    const target = before[0]
    await getDb().promptPresets.update(target.id, { description: "stale" })
    await seedBuiltInPresets()
    const after = await getPreset(target.id)
    // bulkPut overwrites — built-in seed payload is canonical.
    expect(after?.description).not.toBe("stale")
    expect((await listPresets()).filter((p) => p.isBuiltIn).length).toBe(12)
  })

  it("resetPresetsToBuiltIns wipes user rows and reseeds", async () => {
    await seedBuiltInPresets()
    const user = await createPreset({ name: "Mine", content: "x" })
    await resetPresetsToBuiltIns()
    expect(await getPreset(user.id)).toBeUndefined()
    expect((await listPresets()).filter((p) => p.isBuiltIn).length).toBe(12)
  })
})

describe("buildBuiltInPresets / BUILT_IN_PRESET_IDS", () => {
  it("returns 12 distinct rows with the configured timestamp", () => {
    const rows = buildBuiltInPresets(42)
    expect(rows).toHaveLength(12)
    expect(new Set(rows.map((r) => r.id)).size).toBe(12)
    expect(rows.every((r) => r.createdAt === 42 && r.updatedAt === 42)).toBe(true)
  })

  it("BUILT_IN_PRESET_IDS contains every built-in id", () => {
    const rows = buildBuiltInPresets(0)
    for (const r of rows) {
      expect(BUILT_IN_PRESET_IDS.has(r.id)).toBe(true)
    }
  })
})

describe("isBuiltInPreset", () => {
  it("returns true for rows with isBuiltIn=true", async () => {
    await seedBuiltInPresets()
    const builtIn = (await listPresets()).find((p) => p.isBuiltIn)!
    expect(isBuiltInPreset(builtIn)).toBe(true)
  })

  it("returns true for rows with stable built-in ids even when flag missing", () => {
    const id = [...BUILT_IN_PRESET_IDS][0]
    expect(
      isBuiltInPreset({
        id,
        name: "x",
        content: "y",
        createdAt: 0,
        updatedAt: 0,
      })
    ).toBe(true)
  })

  it("returns false for user-created rows", async () => {
    const user = await createPreset({ name: "Mine", content: "x" })
    expect(isBuiltInPreset(user)).toBe(false)
  })
})
