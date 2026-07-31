/** @jest-environment jsdom */
// Coverage for the per-skill resource bundle CRUD layer.

import "fake-indexeddb/auto"
import {
  createResource,
  deleteResource,
  deleteResourcesForSkill,
  getResource,
  listResourcesByKind,
  listResourcesForSkill,
  replaceResourcesForSkill,
  updateResource,
} from "./skill-resources"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().skillResources.clear()
})

describe("createResource", () => {
  it("stamps id/timestamps and computes size for utf-8 content", async () => {
    const r = await createResource({
      skillId: "skill_a",
      kind: "script",
      name: "  ",
      path: "scripts/run.sh",
      content: "echo hi",
    })
    expect(r.id).toMatch(/^skres_/)
    expect(r.encoding).toBe("utf-8")
    expect(r.size).toBeGreaterThan(0)
    // Empty `name` falls back to the basename of the path.
    expect(r.name).toBe("run.sh")
    expect(r.createdAt).toBe(r.updatedAt)
  })

  it("uses `untitled` when both name and basename are empty", async () => {
    const r = await createResource({
      skillId: "skill_a",
      kind: "asset",
      name: "",
      // Path with no segment after a final slash collapses to empty basename.
      path: "assets/",
      content: "x",
    })
    expect(r.name).toBe("untitled")
  })

  it("uses content.length for base64 encoding instead of Blob size", async () => {
    const r = await createResource({
      skillId: "skill_a",
      kind: "asset",
      name: "img",
      path: "img/a.png",
      content: "AAAA",
      encoding: "base64",
    })
    expect(r.size).toBe(4)
  })

  it("respects explicit size if supplied", async () => {
    const r = await createResource({
      skillId: "skill_a",
      kind: "reference",
      name: "doc",
      path: "doc/x.md",
      content: "hi",
      size: 999,
    })
    expect(r.size).toBe(999)
  })

  it("rejects path traversal", async () => {
    await expect(
      createResource({
        skillId: "skill_a",
        kind: "script",
        name: "bad",
        path: "../etc/hosts",
        content: "",
      })
    ).rejects.toThrow(/'..'/)
  })

  it("rejects per-skill duplicate path", async () => {
    await createResource({
      skillId: "skill_a",
      kind: "script",
      name: "one",
      path: "scripts/run.sh",
      content: "1",
    })
    await expect(
      createResource({
        skillId: "skill_a",
        kind: "script",
        name: "dup",
        path: "scripts/run.sh",
        content: "2",
      })
    ).rejects.toThrow(/already exists/)
  })

  it("allows the same path on a different skill", async () => {
    await createResource({
      skillId: "skill_a",
      kind: "script",
      name: "one",
      path: "scripts/run.sh",
      content: "1",
    })
    const ok = await createResource({
      skillId: "skill_b",
      kind: "script",
      name: "two",
      path: "scripts/run.sh",
      content: "2",
    })
    expect(ok.skillId).toBe("skill_b")
  })
})

describe("listResourcesForSkill / listResourcesByKind / getResource", () => {
  it("listResourcesForSkill orders by path", async () => {
    await createResource({
      skillId: "s",
      kind: "script",
      name: "B",
      path: "b.sh",
      content: "x",
    })
    await createResource({
      skillId: "s",
      kind: "script",
      name: "A",
      path: "a.sh",
      content: "y",
    })
    const rows = await listResourcesForSkill("s")
    expect(rows.map((r) => r.path)).toEqual(["a.sh", "b.sh"])
  })

  it("listResourcesByKind filters using the compound index", async () => {
    await createResource({
      skillId: "s",
      kind: "script",
      name: "A",
      path: "a.sh",
      content: "x",
    })
    await createResource({
      skillId: "s",
      kind: "reference",
      name: "B",
      path: "b.md",
      content: "y",
    })
    const scripts = await listResourcesByKind("s", "script")
    expect(scripts.map((r) => r.path)).toEqual(["a.sh"])
  })

  it("getResource returns the row by id", async () => {
    const r = await createResource({
      skillId: "s",
      kind: "asset",
      name: "x",
      path: "x.png",
      content: "x",
    })
    expect((await getResource(r.id))?.id).toBe(r.id)
    expect(await getResource("missing")).toBeUndefined()
  })
})

describe("updateResource", () => {
  it("merges patch and bumps updatedAt", async () => {
    const r = await createResource({
      skillId: "s",
      kind: "script",
      name: "A",
      path: "a.sh",
      content: "x",
    })
    await new Promise((res) => setTimeout(res, 5))
    await updateResource(r.id, { content: "y" })
    const fresh = await getResource(r.id)
    expect(fresh?.content).toBe("y")
    expect(fresh?.updatedAt).toBeGreaterThan(r.updatedAt)
  })

  it("rejects path patch that contains '..'", async () => {
    const r = await createResource({
      skillId: "s",
      kind: "script",
      name: "A",
      path: "a.sh",
      content: "x",
    })
    await expect(updateResource(r.id, { path: "../escape" })).rejects.toThrow(/'..'/)
  })
})

describe("deleteResource / deleteResourcesForSkill", () => {
  it("delete removes a single row", async () => {
    const r = await createResource({
      skillId: "s",
      kind: "script",
      name: "A",
      path: "a.sh",
      content: "x",
    })
    await deleteResource(r.id)
    expect(await getResource(r.id)).toBeUndefined()
  })

  it("deleteResourcesForSkill nukes the whole bundle", async () => {
    await createResource({
      skillId: "s",
      kind: "script",
      name: "A",
      path: "a.sh",
      content: "x",
    })
    await createResource({
      skillId: "s",
      kind: "asset",
      name: "B",
      path: "b.png",
      content: "y",
    })
    // Resources for an unrelated skill must survive.
    await createResource({
      skillId: "other",
      kind: "script",
      name: "X",
      path: "x.sh",
      content: "z",
    })
    await deleteResourcesForSkill("s")
    expect(await listResourcesForSkill("s")).toEqual([])
    expect(await listResourcesForSkill("other")).toHaveLength(1)
  })
})

describe("replaceResourcesForSkill", () => {
  it("clears existing rows and writes fresh ones", async () => {
    const original = await createResource({
      skillId: "s",
      kind: "script",
      name: "Old",
      path: "old.sh",
      content: "x",
    })
    const created = await replaceResourcesForSkill("s", [
      { skillId: "ignored", kind: "reference", name: "Doc", path: "doc.md", content: "y" },
    ])
    expect(created).toHaveLength(1)
    expect(created[0].skillId).toBe("s") // skillId arg overrides draft
    expect(created[0].path).toBe("doc.md")
    expect(await getResource(original.id)).toBeUndefined()
  })

  it("returns an empty array when called with no drafts", async () => {
    expect(await replaceResourcesForSkill("s", [])).toEqual([])
  })
})
