/** @jest-environment jsdom */
/**
 * Coverage for the wiki MCP handlers — `wiki_search` ranking + `wiki_read`
 * lookup. Drives Dexie via fake-indexeddb so the handlers exercise the
 * real CRUD paths.
 */

import "fake-indexeddb/auto"
import { __TESTING__, wikiRead, wikiSearch } from "./wiki"
import { createWikiArticle } from "@/lib/db/wiki-articles"
import { SELF_CORPUS_ID } from "@/types/wiki"
import type { WikiArticleDraft } from "@/lib/db/wiki-articles"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30_000)

function draft(overrides: Partial<WikiArticleDraft> = {}): WikiArticleDraft {
  return {
    slug: overrides.slug ?? "lib-foo",
    title: overrides.title ?? "lib/foo overview",
    module: overrides.module ?? "lib/foo",
    scope: overrides.scope ?? "cognia-self",
    corpusId: overrides.corpusId ?? SELF_CORPUS_ID,
    pageRank: overrides.pageRank ?? 0.5,
    summary: overrides.summary ?? "summary",
    sectionIds: overrides.sectionIds ?? [],
    sourceRefs: overrides.sourceRefs ?? [
      { filePath: "lib/foo/index.ts", lineStart: 1, lineEnd: 10, sha: "abc" },
    ],
    contentMd: overrides.contentMd ?? "# heading\n\nbody",
    embedding: overrides.embedding ?? [],
    generatorVersion: overrides.generatorVersion ?? "v1",
    fileHashes: overrides.fileHashes ?? { "lib/foo/index.ts": "abc" },
  }
}

describe("wikiSearch", () => {
  it("returns empty results when there are no articles", async () => {
    const out = await wikiSearch({ query: "anything" })
    expect(out.results).toEqual([])
    expect(out.considered).toBe(0)
  })

  it("returns top-K by pageRank when query is empty", async () => {
    await createWikiArticle(draft({ slug: "a", pageRank: 0.1 }))
    await createWikiArticle(draft({ slug: "b", pageRank: 0.9 }))
    await createWikiArticle(draft({ slug: "c", pageRank: 0.5 }))
    const out = await wikiSearch({ query: "  " })
    expect(out.results.map((r) => r.slug)).toEqual(["b", "c", "a"])
  })

  it("returns BM25-matching articles, excludes non-matching, sorted by score", async () => {
    await createWikiArticle(draft({ slug: "title-hit", title: "Twin distill orchestrator" }))
    await createWikiArticle(
      draft({ slug: "summary-hit", title: "Other module", summary: "uses twin distill flow" })
    )
    await createWikiArticle(draft({ slug: "no-hit", title: "Unrelated", summary: "no match" }))
    const out = await wikiSearch({ query: "twin distill" })
    const slugs = out.results.map((r) => r.slug)
    expect(slugs).toContain("title-hit")
    expect(slugs).toContain("summary-hit")
    expect(slugs).not.toContain("no-hit")
    for (let i = 1; i < out.results.length; i++) {
      expect(out.results[i - 1].score).toBeGreaterThanOrEqual(out.results[i].score)
    }
  })

  it("clamps k to the [1, 20] range", async () => {
    for (let i = 0; i < 25; i++) {
      await createWikiArticle(draft({ slug: `s${i}`, pageRank: i / 25 }))
    }
    const max = await wikiSearch({ query: "" })
    expect(max.results.length).toBe(__TESTING__.DEFAULT_K)
    const overK = await wikiSearch({ query: "", k: 999 })
    expect(overK.results.length).toBe(__TESTING__.MAX_K)
    const underK = await wikiSearch({ query: "", k: 0 })
    expect(underK.results.length).toBe(__TESTING__.MIN_K)
    const nanK = await wikiSearch({ query: "", k: NaN })
    expect(nanK.results.length).toBe(__TESTING__.MIN_K)
  })

  it("filters by scope when provided", async () => {
    await createWikiArticle(draft({ slug: "a", scope: "cognia-self", title: "twin" }))
    await createWikiArticle(draft({ slug: "b", scope: "user-repo", title: "twin" }))
    const out = await wikiSearch({ query: "twin", scope: "user-repo" })
    expect(out.results.map((r) => r.slug)).toEqual(["b"])
  })

  it("returns considered count for diagnostics on empty results", async () => {
    await createWikiArticle(draft({ slug: "a", title: "Unrelated" }))
    const out = await wikiSearch({ query: "ghostword" })
    expect(out.results).toEqual([])
    expect(out.considered).toBe(1)
  })
})

describe("wikiRead", () => {
  it("returns the full article body (untrusted-wrapped) for a known slug", async () => {
    await createWikiArticle(draft({ slug: "needle", contentMd: "# full body" }))
    const out = await wikiRead({ slug: "needle" })
    expect(out?.contentMd).toBe("<untrusted_content>\n# full body\n</untrusted_content>")
    expect(out?.sourceRefs).toHaveLength(1)
  })

  it("returns undefined for an unknown slug", async () => {
    expect(await wikiRead({ slug: "ghost" })).toBeUndefined()
  })

  it("returns undefined for an empty slug", async () => {
    expect(await wikiRead({ slug: "  " })).toBeUndefined()
    expect(await wikiRead({ slug: "" })).toBeUndefined()
  })
})

describe("internal helpers", () => {
  it("clamp coerces NaN to min and clamps to bounds", () => {
    expect(__TESTING__.clamp(NaN, 1, 10)).toBe(1)
    expect(__TESTING__.clamp(99, 1, 10)).toBe(10)
    expect(__TESTING__.clamp(0, 1, 10)).toBe(1)
    expect(__TESTING__.clamp(5, 1, 10)).toBe(5)
  })
})
