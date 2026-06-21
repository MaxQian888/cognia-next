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
  renderSkillsCatalog,
  renderSkillsSection,
  seedBuiltInSkills,
  setSkillStatus,
  updateSkill,
  upsertSkillByCanonicalId,
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

describe("renderSkillsCatalog (name-only / progressive disclosure)", () => {
  it("returns empty string for empty input", () => {
    expect(renderSkillsCatalog([])).toBe("")
  })

  it("lists id + name + description, NOT the body, and points at load_skill", () => {
    const out = renderSkillsCatalog([
      { id: "research", name: "Research", description: "Deep research", content: "SECRET BODY" },
      { id: "lint", name: "Lint", content: "another body" },
    ] as Parameters<typeof renderSkillsCatalog>[0])
    expect(out).toContain("## Available skills")
    expect(out).toContain("`load_skill`")
    expect(out).toContain("- `research` — Research: Deep research")
    // A description-less skill still lists its name.
    expect(out).toContain("- `lint` — Lint")
    // The full body must never leak into the catalog (that's the whole point).
    expect(out).not.toContain("SECRET BODY")
    expect(out).not.toContain("another body")
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

  it("dispatches drafts with a canonicalId to the idempotent upsert path", async () => {
    const r1 = await bulkImportSkills([
      { name: "Reviewer", content: "v1", canonicalId: "bundle:demo" },
    ])
    expect(r1.created).toBe(1)
    const created = (await listSkills()).find((s) => s.canonicalId === "bundle:demo")!
    expect(created).toBeDefined()
    const r2 = await bulkImportSkills([
      { name: "Reviewer 2", content: "v2", canonicalId: "bundle:demo" },
    ])
    expect(r2.created).toBe(0)
    expect(r2.updated).toBe(1)
    const refreshed = await getSkill(created.id)
    expect(refreshed?.content).toBe("v2")
    expect(refreshed?.name).toBe("Reviewer 2")
  })

  it("persists resources alongside the row when the draft carries them", async () => {
    const result = await bulkImportSkills([
      {
        name: "WithResources",
        content: "body",
        canonicalId: "bundle:resources",
        resources: [
          { kind: "script", name: "check.sh", path: "scripts/check.sh", content: "#!/bin/bash\n" },
          {
            kind: "reference",
            name: "notes.md",
            path: "references/notes.md",
            content: "# notes\n",
          },
        ],
      },
    ])
    expect(result.created).toBe(1)
    const created = (await listSkills()).find((s) => s.canonicalId === "bundle:resources")!
    const resources = await listResourcesForSkill(created.id)
    expect(resources).toHaveLength(2)
    expect(resources.map((r) => r.path).sort()).toEqual(["references/notes.md", "scripts/check.sh"])
  })

  it("rewrites the resource table on overwrite via canonicalId upsert", async () => {
    await bulkImportSkills([
      {
        name: "R",
        content: "v1",
        canonicalId: "bundle:rewrite",
        resources: [{ kind: "script", name: "a.sh", path: "scripts/a.sh", content: "old" }],
      },
    ])
    await bulkImportSkills([
      {
        name: "R",
        content: "v2",
        canonicalId: "bundle:rewrite",
        resources: [{ kind: "reference", name: "b.md", path: "references/b.md", content: "new" }],
      },
    ])
    const skill = (await listSkills()).find((s) => s.canonicalId === "bundle:rewrite")!
    const resources = await listResourcesForSkill(skill.id)
    expect(resources).toHaveLength(1)
    expect(resources[0].path).toBe("references/b.md")
  })

  it("also rewrites resources on the name-collision overwrite branch", async () => {
    const existing = await createSkill({ name: "Same", content: "old" })
    await createResource({
      skillId: existing.id,
      kind: "script",
      name: "old.sh",
      path: "scripts/old.sh",
      content: "old",
    })
    await bulkImportSkills(
      [
        {
          name: "Same",
          content: "new",
          resources: [
            { kind: "reference", name: "new.md", path: "references/new.md", content: "new" },
          ],
        },
      ],
      "overwrite"
    )
    const resources = await listResourcesForSkill(existing.id)
    expect(resources.map((r) => r.path)).toEqual(["references/new.md"])
  })
})

describe("upsertSkillByCanonicalId", () => {
  it("creates a row when no canonicalId matches", async () => {
    const { skill, created } = await upsertSkillByCanonicalId({
      draft: { name: "Fresh", content: "body" },
      canonicalId: "bundle:fresh",
    })
    expect(created).toBe(true)
    expect(skill.canonicalId).toBe("bundle:fresh")
  })

  it("updates in place when the canonicalId matches; id stays stable", async () => {
    const first = await upsertSkillByCanonicalId({
      draft: { name: "Stable", content: "v1" },
      canonicalId: "bundle:stable",
    })
    const second = await upsertSkillByCanonicalId({
      draft: { name: "Stable", content: "v2" },
      canonicalId: "bundle:stable",
    })
    expect(second.created).toBe(false)
    expect(second.skill.id).toBe(first.skill.id)
    expect(second.skill.content).toBe("v2")
  })

  it("preserves the previous canonicalId-bearing row when fields are partially supplied", async () => {
    await upsertSkillByCanonicalId({
      draft: {
        name: "Keep",
        content: "body",
        author: "alice",
        license: "MIT",
        category: "development",
      },
      canonicalId: "bundle:keep",
    })
    const after = await upsertSkillByCanonicalId({
      draft: { name: "Keep", content: "body2" },
      canonicalId: "bundle:keep",
    })
    expect(after.skill.author).toBe("alice")
    expect(after.skill.license).toBe("MIT")
    expect(after.skill.category).toBe("development")
  })

  it("replaces the resource set when supplied (old resources gone)", async () => {
    const created = await upsertSkillByCanonicalId({
      draft: {
        name: "R",
        content: "body",
        resources: [{ kind: "script", name: "a.sh", path: "scripts/a.sh", content: "old" }],
      },
      canonicalId: "bundle:res-replace",
    })
    await upsertSkillByCanonicalId({
      draft: {
        name: "R",
        content: "body",
        resources: [{ kind: "reference", name: "b.md", path: "references/b.md", content: "new" }],
      },
      canonicalId: "bundle:res-replace",
    })
    const resources = await listResourcesForSkill(created.skill.id)
    expect(resources).toHaveLength(1)
    expect(resources[0].path).toBe("references/b.md")
  })
})

describe("seedBuiltInSkills", () => {
  it("seeds the 5 generic + 8 functional built-ins idempotently and preserves status", async () => {
    await seedBuiltInSkills()
    const all = await listSkills()
    const builtIns = all.filter((s) => s.isBuiltIn)
    // 5 generic style skills + the surface-guidance catalog (8 entries).
    expect(builtIns.length).toBe(13)
    // Disable one, then reseed; status must be preserved.
    await setSkillStatus(builtIns[0].id, "disabled")
    await seedBuiltInSkills()
    expect((await getSkill(builtIns[0].id))?.status).toBe("disabled")
    // No duplicates introduced.
    const after = await listSkills()
    expect(after.filter((s) => s.isBuiltIn).length).toBe(13)
  })

  it("seeds functional catalog skills disabled by default, keyed by canonical id", async () => {
    await seedBuiltInSkills()
    const im = await getSkill("skill_builtin_im_auto_reply")
    expect(im).toBeDefined()
    expect(im?.isBuiltIn).toBe(true)
    expect(im?.status).toBe("disabled")
    expect(im?.canonicalId).toBe("builtin:im-auto-reply")
    expect(im?.content.length).toBeGreaterThan(0)
    // The generic style skills stay enabled.
    expect((await getSkill("skill_builtin_concise"))?.status).toBe("enabled")
  })

  it("persists each functional skill's reference resources, idempotently", async () => {
    await seedBuiltInSkills()
    const refs = await listResourcesForSkill("skill_builtin_im_auto_reply")
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.every((r) => r.kind === "reference")).toBe(true)
    expect(refs.some((r) => r.path.startsWith("references/"))).toBe(true)
    // Reseeding must not duplicate resources (idempotent guard).
    await seedBuiltInSkills()
    const after = await listResourcesForSkill("skill_builtin_im_auto_reply")
    expect(after.length).toBe(refs.length)
  })
})
