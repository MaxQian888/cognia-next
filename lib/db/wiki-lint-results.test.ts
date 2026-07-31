/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  getWikiLintResult,
  upsertWikiLintResult,
  listAllWikiLintResults,
  deleteWikiLintResult,
} from "./wiki-lint-results"
import type { WikiLintResult } from "@/types/wiki"

function row(over: Partial<WikiLintResult> = {}): WikiLintResult {
  return {
    scope: "cognia-self",
    lastRunAt: 1000,
    articleCount: 3,
    brokenLinks: [],
    orphans: [{ slug: "x", title: "X" }],
    ...over,
  }
}

describe("wiki-lint-results CRUD", () => {
  // Cold-opening the versioned CogniaDB under fake-indexeddb can exceed the
  // default 5s timeout on the first DB touch; give it headroom.
  it("upserts, reads, lists and deletes a result row", async () => {
    await upsertWikiLintResult(row())
    expect((await getWikiLintResult("cognia-self"))?.articleCount).toBe(3)

    // Upsert replaces (singleton per scope).
    await upsertWikiLintResult(row({ articleCount: 9 }))
    expect((await getWikiLintResult("cognia-self"))?.articleCount).toBe(9)

    expect(await listAllWikiLintResults()).toHaveLength(1)

    await deleteWikiLintResult("cognia-self")
    expect(await getWikiLintResult("cognia-self")).toBeUndefined()
  }, 30_000)
})
