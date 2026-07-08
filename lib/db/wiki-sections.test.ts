/** @jest-environment jsdom */
/**
 * Coverage for `lib/db/wiki-sections.ts` — section CRUD + ordering.
 */

import "fake-indexeddb/auto"
import {
  bulkCreateWikiSections,
  createWikiSection,
  deleteWikiSection,
  deleteWikiSectionsByArticle,
  getWikiSection,
  listWikiSectionsByArticle,
  updateWikiSection,
} from "./wiki-sections"
import type { WikiSectionDraft } from "./wiki-sections"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function makeDraft(overrides: Partial<WikiSectionDraft> = {}): WikiSectionDraft {
  return {
    articleId: overrides.articleId ?? "wka_test",
    sectionIndex: overrides.sectionIndex ?? 0,
    headingPath: overrides.headingPath ?? ["intro"],
    bodyMd: overrides.bodyMd ?? "section body",
    sourceRefs: overrides.sourceRefs ?? [],
    ...overrides,
  }
}

describe("wiki-sections CRUD", () => {
  it("creates and reads back a section", async () => {
    const created = await createWikiSection(makeDraft())
    expect(created.id).toMatch(/^wks_/)
    const fetched = await getWikiSection(created.id)
    expect(fetched).toEqual(created)
  })

  it("honors caller-supplied id", async () => {
    const row = await createWikiSection(makeDraft({ id: "wks_custom" }))
    expect(row.id).toBe("wks_custom")
  })

  it("bulkCreateWikiSections short-circuits on empty input", async () => {
    expect(await bulkCreateWikiSections([])).toEqual([])
  })

  it("bulkCreateWikiSections inserts every row", async () => {
    const rows = await bulkCreateWikiSections([
      makeDraft({ sectionIndex: 0 }),
      makeDraft({ sectionIndex: 1 }),
      makeDraft({ sectionIndex: 2 }),
    ])
    expect(rows).toHaveLength(3)
    expect(await getDb().wikiSections.count()).toBe(3)
  })

  it("listWikiSectionsByArticle returns sections in sectionIndex order", async () => {
    await bulkCreateWikiSections([
      makeDraft({ articleId: "a1", sectionIndex: 2, bodyMd: "third" }),
      makeDraft({ articleId: "a1", sectionIndex: 0, bodyMd: "first" }),
      makeDraft({ articleId: "a1", sectionIndex: 1, bodyMd: "second" }),
      makeDraft({ articleId: "a2", sectionIndex: 0, bodyMd: "other-article" }),
    ])
    const sections = await listWikiSectionsByArticle("a1")
    expect(sections.map((s) => s.bodyMd)).toEqual(["first", "second", "third"])
  })

  it("listWikiSectionsByArticle returns empty for unknown articleId", async () => {
    expect(await listWikiSectionsByArticle("a_nope")).toEqual([])
  })

  it("updateWikiSection patches and returns updated row", async () => {
    const created = await createWikiSection(makeDraft({ bodyMd: "before" }))
    const updated = await updateWikiSection(created.id, { bodyMd: "after" })
    expect(updated?.bodyMd).toBe("after")
  })

  it("updateWikiSection returns undefined for unknown id", async () => {
    expect(await updateWikiSection("wks_nope", { bodyMd: "x" })).toBeUndefined()
  })

  it("deleteWikiSection removes a single row", async () => {
    const row = await createWikiSection(makeDraft())
    await deleteWikiSection(row.id)
    expect(await getWikiSection(row.id)).toBeUndefined()
  })

  it("deleteWikiSectionsByArticle removes all sections for one article", async () => {
    await bulkCreateWikiSections([
      makeDraft({ articleId: "a1", sectionIndex: 0 }),
      makeDraft({ articleId: "a1", sectionIndex: 1 }),
      makeDraft({ articleId: "a2", sectionIndex: 0 }),
    ])
    const deleted = await deleteWikiSectionsByArticle("a1")
    expect(deleted).toBe(2)
    expect(await listWikiSectionsByArticle("a1")).toEqual([])
    expect(await listWikiSectionsByArticle("a2")).toHaveLength(1)
  })
})
