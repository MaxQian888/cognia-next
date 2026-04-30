// Coverage for the skills CRUD layer + bulk-import + render helpers.

import "fake-indexeddb/auto"
import {
  bulkImportSkills,
  createSkill,
  deleteSkill,
  duplicateSkill,
  getSkill,
  inferCategory,
  inferSource,
  listEnabledSkillsByIds,
  listSkills,
  listSkillsByIds,
  recordSkillUsage,
  renderSkillsSection,
  seedBuiltInSkills,
  setSkillStatus,
  updateSkill,
} from "./skills"
import { createResource, listResourcesForSkill } from "./skill-resources"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().skills.clear()
  await getDb().skillResources.clear()
})

describe("createSkill", () => {
  it("inserts a row with sensible defaults", async () => {
    const s = await createSkill({ name: "  Concise  ", content: "Be brief." })
    expect(s.id).toMatch(/^skill_/)
    expect(s.name).toBe("Concise")
    expect(s.category).toBe("custom")
    expect(s.source).toBe("custom")
    expect(s.status).toBe("enabled")
    expect(s.usageCount).toBe(0)
    expect(s.syncOrigin).toBe("frontend")
  })

  it("falls back to 'Untitled skill' on empty name", async () => {
    const s = await createSkill({ name: "   ", content: "x" })
    expect(s.name).toBe("Untitled skill")
  })

  it("preserves explicit category/source/status when supplied", async () => {
    const s = await createSkill({
      name: "X",
      content: "x",
      category: "development",
      source: "imported",
      status: "disabled",
      tags: ["a"],
    })
    expect(s.category).toBe("development")
    expect(s.source).toBe("imported")
    expect(s.status).toBe("disabled")
    expect(s.tags).toEqual(["a"])
  })
})

describe("listSkills / listSkillsByIds", () => {
  it("listSkills orders by name", async () => {
    await createSkill({ name: "C", content: "x" })
    await createSkill({ name: "A", content: "x" })
    await createSkill({ name: "B", content: "x" })
    const rows = await listSkills()
    expect(rows.map((r) => r.name)).toEqual(["A", "B", "C"])
  })

  it("listSkillsByIds preserves caller order and drops missing", async () => {
    const a = await createSkill({ name: "A", content: "x" })
    const b = await createSkill({ name: "B", content: "x" })
    const out = await listSkillsByIds([b.id, "missing", a.id])
    expect(out.map((r) => r.id)).toEqual([b.id, a.id])
    expect(await listSkillsByIds([])).toEqual([])
  })
})

describe("updateSkill / setSkillStatus", () => {
  it("merges patch and bumps updatedAt", async () => {
    const s = await createSkill({ name: "A", content: "x" })
    await new Promise((r) => setTimeout(r, 5))
    await updateSkill(s.id, { description: "patched" })
    const fresh = await getSkill(s.id)
    expect(fresh?.description).toBe("patched")
    expect(fresh?.updatedAt).toBeGreaterThan(s.updatedAt)
  })

  it("setSkillStatus toggles between enabled/disabled", async () => {
    const s = await createSkill({ name: "A", content: "x" })
    await setSkillStatus(s.id, "disabled")
    expect((await getSkill(s.id))?.status).toBe("disabled")
    await setSkillStatus(s.id, "enabled")
    expect((await getSkill(s.id))?.status).toBe("enabled")
  })
})

describe("deleteSkill", () => {
  it("rejects deletion of built-ins", async () => {
    await seedBuiltInSkills()
    const builtIn = (await listSkills()).find((s) => s.isBuiltIn)!
    await expect(deleteSkill(builtIn.id)).rejects.toThrow(/Built-in/)
  })

  it("cascades to skillResources", async () => {
    const s = await createSkill({ name: "A", content: "x" })
    await createResource({
      skillId: s.id,
      kind: "script",
      name: "r",
      path: "scripts/r.sh",
      content: "echo",
    })
    await deleteSkill(s.id)
    expect(await getSkill(s.id)).toBeUndefined()
    expect(await listResourcesForSkill(s.id)).toEqual([])
  })

  it("is a no-op for missing ids", async () => {
    await expect(deleteSkill("missing")).resolves.toBeUndefined()
  })
})

describe("duplicateSkill", () => {
  it("clones source but resets identity / sync / usage fields", async () => {
    await seedBuiltInSkills()
    const builtIn = (await listSkills()).find((s) => s.isBuiltIn)!
    const copy = await duplicateSkill(builtIn.id)
    expect(copy.id).not.toBe(builtIn.id)
    expect(copy.name).toBe(`${builtIn.name} (copy)`)
    expect(copy.isBuiltIn).toBe(false)
    expect(copy.source).toBe("custom")
    expect(copy.canonicalId).toBeUndefined()
    expect(copy.usageCount).toBe(0)
  })

  it("throws when source is missing", async () => {
    await expect(duplicateSkill("missing")).rejects.toThrow(/not found/)
  })
})

describe("recordSkillUsage", () => {
  it("bumps usageCount and stamps lastUsedAt for each id", async () => {
    const a = await createSkill({ name: "A", content: "x" })
    const b = await createSkill({ name: "B", content: "x" })
    await recordSkillUsage([a.id, b.id, "missing"])
    expect((await getSkill(a.id))?.usageCount).toBe(1)
    expect((await getSkill(b.id))?.usageCount).toBe(1)
    expect(typeof (await getSkill(a.id))?.lastUsedAt).toBe("number")
  })

  it("is a no-op for empty input", async () => {
    await expect(recordSkillUsage([])).resolves.toBeUndefined()
  })
})

describe("listEnabledSkillsByIds", () => {
  it("filters out disabled rows", async () => {
    const a = await createSkill({ name: "A", content: "x" })
    const b = await createSkill({ name: "B", content: "x" })
    await setSkillStatus(b.id, "disabled")
    const enabled = await listEnabledSkillsByIds([a.id, b.id])
    expect(enabled.map((r) => r.id)).toEqual([a.id])
  })

  it("treats undefined status as enabled (back-compat)", async () => {
    const a = await createSkill({ name: "A", content: "x" })
    // Strip the status so we hit the back-compat branch.
    await getDb().skills.update(a.id, { status: undefined })
    const out = await listEnabledSkillsByIds([a.id])
    expect(out.map((r) => r.id)).toEqual([a.id])
  })
})

describe("inferCategory / inferSource", () => {
  it("returns the explicit category when present", () => {
    const skill = { category: "development", isBuiltIn: false } as Parameters<
      typeof inferCategory
    >[0]
    expect(inferCategory(skill)).toBe("development")
  })

  it("falls back to meta for built-ins, custom otherwise", () => {
    expect(inferCategory({ isBuiltIn: true } as Parameters<typeof inferCategory>[0])).toBe("meta")
    expect(inferCategory({ isBuiltIn: false } as Parameters<typeof inferCategory>[0])).toBe(
      "custom"
    )
  })

  it("inferSource uses the explicit source then isBuiltIn fallback", () => {
    expect(inferSource({ source: "imported" } as Parameters<typeof inferSource>[0])).toBe(
      "imported"
    )
    expect(inferSource({ isBuiltIn: true } as Parameters<typeof inferSource>[0])).toBe("builtin")
    expect(inferSource({ isBuiltIn: false } as Parameters<typeof inferSource>[0])).toBe("custom")
  })
})

describe("renderSkillsSection", () => {
  it("returns empty string for empty input", () => {
    expect(renderSkillsSection([])).toBe("")
  })

  it("formats every skill as a `## <name>` block", () => {
    const out = renderSkillsSection([
      { name: "One", content: "  body 1  " },
      { name: "Two", content: "body 2" },
    ] as Parameters<typeof renderSkillsSection>[0])
    expect(out).toBe("## One\n\nbody 1\n\n## Two\n\nbody 2")
  })
})

describe("bulkImportSkills", () => {
  it("creates new skills for non-colliding drafts", async () => {
    const result = await bulkImportSkills([
      { name: "New A", content: "x" },
      { name: "New B", content: "y" },
    ])
    expect(result.created).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.errored).toEqual([])
  })

  it("skips on collision under the default strategy", async () => {
    await createSkill({ name: "Dup", content: "old" })
    const result = await bulkImportSkills([{ name: "dup", content: "new" }])
    expect(result.skipped).toBe(1)
    expect(result.created).toBe(0)
    const all = await listSkills()
    expect(all.find((s) => s.name === "Dup")?.content).toBe("old")
  })

  it("overwrites existing custom skill on overwrite", async () => {
    const existing = await createSkill({ name: "Dup", content: "old" })
    const result = await bulkImportSkills(
      [{ name: "Dup", content: "new", description: "desc" }],
      "overwrite"
    )
    expect(result.updated).toBe(1)
    expect((await getSkill(existing.id))?.content).toBe("new")
    expect((await getSkill(existing.id))?.description).toBe("desc")
  })

  it("falls back to duplicate when overwrite would touch a built-in", async () => {
    await seedBuiltInSkills()
    const builtIn = (await listSkills()).find((s) => s.isBuiltIn)!
    const result = await bulkImportSkills([{ name: builtIn.name, content: "alt" }], "overwrite")
    expect(result.created).toBe(1)
    const renamed = (await listSkills()).find((s) => s.name === `${builtIn.name} (imported)`)
    expect(renamed).toBeDefined()
  })

  it("creates duplicates with (imported) suffix under duplicate strategy", async () => {
    await createSkill({ name: "Dup", content: "old" })
    const result = await bulkImportSkills([{ name: "Dup", content: "new" }], "duplicate")
    expect(result.created).toBe(1)
    const renamed = (await listSkills()).find((s) => s.name === "Dup (imported)")
    expect(renamed).toBeDefined()
  })

  it("records errors for missing names", async () => {
    const result = await bulkImportSkills([
      { name: "", content: "x" },
      { name: "  ", content: "x" },
    ])
    expect(result.errored.length).toBe(2)
    expect(result.errored[0].error).toMatch(/missing a name/)
  })
})

describe("seedBuiltInSkills", () => {
  it("seeds 5 built-ins idempotently and preserves user-toggled status", async () => {
    await seedBuiltInSkills()
    const all = await listSkills()
    const builtIns = all.filter((s) => s.isBuiltIn)
    expect(builtIns.length).toBe(5)
    // Disable one, then reseed; status must be preserved.
    await setSkillStatus(builtIns[0].id, "disabled")
    await seedBuiltInSkills()
    expect((await getSkill(builtIns[0].id))?.status).toBe("disabled")
    // No duplicates introduced.
    const after = await listSkills()
    expect(after.filter((s) => s.isBuiltIn).length).toBe(5)
  })
})
