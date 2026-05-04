/**
 * Coverage for the `rag_search` MCP handler. Drives section-level retrieval
 * over fake-indexeddb so the BM25-ish ranker exercises real Dexie reads.
 */

import "fake-indexeddb/auto"
import { __TESTING__, ragSearch } from "./rag"
import { createWikiArticle } from "@/lib/db/wiki-articles"
import { bulkCreateWikiSections } from "@/lib/db/wiki-sections"
import type { WikiArticleDraft } from "@/lib/db/wiki-articles"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function articleDraft(overrides: Partial<WikiArticleDraft> = {}): WikiArticleDraft {
  return {
    slug: overrides.slug ?? "lib-foo",
    title: overrides.title ?? "lib/foo",
    module: overrides.module ?? "lib/foo",
    scope: overrides.scope ?? "cognia-self",
    pageRank: overrides.pageRank ?? 0.5,
    summary: overrides.summary ?? "summary",
    sectionIds: overrides.sectionIds ?? [],
    sourceRefs: overrides.sourceRefs ?? [],
    contentMd: overrides.contentMd ?? "",
    embedding: overrides.embedding ?? [],
    generatorVersion: overrides.generatorVersion ?? "v1",
    fileHashes: overrides.fileHashes ?? {},
  }
}

async function seedArticleWithSections(
  slug: string,
  sections: { body: string; filePath?: string }[],
  overrides: Partial<WikiArticleDraft> = {}
) {
  const article = await createWikiArticle(articleDraft({ slug, ...overrides }))
  await bulkCreateWikiSections(
    sections.map((s, i) => ({
      articleId: article.id,
      sectionIndex: i,
      headingPath: [`Section ${i}`],
      bodyMd: s.body,
      sourceRefs: s.filePath ? [{ filePath: s.filePath, lineStart: 1, lineEnd: 10, sha: "h" }] : [],
    }))
  )
}

describe("ragSearch", () => {
  it("returns empty for empty queries", async () => {
    expect(await ragSearch({ query: "" })).toEqual({ chunks: [], considered: 0 })
    expect(await ragSearch({ query: "   " })).toEqual({ chunks: [], considered: 0 })
  })

  it("returns empty when no articles exist", async () => {
    expect(await ragSearch({ query: "anything" })).toEqual({ chunks: [], considered: 0 })
  })

  it("scores body keyword matches and sorts descending", async () => {
    await seedArticleWithSections("a", [
      { body: "twin distill orchestrator usage" },
      { body: "unrelated content" },
    ])
    const out = await ragSearch({ query: "twin distill" })
    expect(out.chunks[0].content).toContain("twin distill")
    expect(out.chunks[0].score).toBeGreaterThan(0)
  })

  it("boosts when the cited file path matches a query token", async () => {
    await seedArticleWithSections(
      "a",
      [{ body: "irrelevant body", filePath: "lib/twin/ingest/chunk.ts" }],
      { module: "lib/twin/ingest" }
    )
    await seedArticleWithSections("b", [{ body: "twin ingest details from file" }], {
      module: "lib/foo",
    })
    const out = await ragSearch({ query: "twin ingest" })
    // The body-matching section ranks above the path-only section.
    expect(out.chunks[0].articleSlug).toBe("b")
  })

  it("filters by scope when provided", async () => {
    await seedArticleWithSections("self", [{ body: "match me" }], { scope: "cognia-self" })
    await seedArticleWithSections("user", [{ body: "match me" }], { scope: "user-repo" })
    const out = await ragSearch({ query: "match", scope: "user-repo" })
    expect(out.chunks).toHaveLength(1)
    expect(out.chunks[0].articleSlug).toBe("user")
  })

  it("clamps k to [1, 30]", async () => {
    const sections = Array.from({ length: 40 }, (_, i) => ({ body: `match item ${i}` }))
    await seedArticleWithSections("a", sections)
    const out = await ragSearch({ query: "match", k: 999 })
    expect(out.chunks.length).toBe(__TESTING__.MAX_K)
    const min = await ragSearch({ query: "match", k: 0 })
    expect(min.chunks.length).toBeLessThanOrEqual(__TESTING__.MIN_K)
  })

  it("includes source ref when section cites a file", async () => {
    await seedArticleWithSections("a", [
      { body: "matching content here", filePath: "lib/foo/bar.ts" },
    ])
    const out = await ragSearch({ query: "matching" })
    expect(out.chunks[0].filePath).toBe("lib/foo/bar.ts")
    expect(out.chunks[0].lineStart).toBe(1)
  })

  it("falls back to lineStart=0 when section has no source refs", async () => {
    await seedArticleWithSections("a", [{ body: "matching" }])
    const out = await ragSearch({ query: "matching" })
    expect(out.chunks[0].filePath).toBe("")
    expect(out.chunks[0].lineStart).toBe(0)
  })
})

describe("internal helpers", () => {
  it("scoreSection returns 0 for empty inputs", () => {
    const article = articleDraft() as unknown as Parameters<typeof __TESTING__.scoreSection>[0]
    expect(__TESTING__.scoreSection(article, "", [], ["x"])).toBe(0)
    expect(__TESTING__.scoreSection(article, "body", [], [])).toBe(0)
  })

  it("clamp ignores NaN and clamps to bounds", () => {
    expect(__TESTING__.clamp(5, 1, 10)).toBe(5)
    expect(__TESTING__.clamp(NaN, 1, 10)).toBe(1)
    expect(__TESTING__.clamp(99, 1, 10)).toBe(10)
  })

  it("tokenize matches the wiki tokenizer's behavior", () => {
    expect(__TESTING__.tokenize("Twin Distill")).toEqual(["twin", "distill"])
  })
})
