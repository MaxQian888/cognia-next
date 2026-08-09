/**
 * Coverage for `lib/db/wiki-articles.ts` — the v17 wiki articles CRUD layer.
 * Hits create/bulkCreate/get/listByScope/listByScopeAndModule/count, the
 * cascade-delete path that wipes the article's sections, and the
 * generator-version invalidation.
 */

import {
  bulkCreateWikiArticles,
  countWikiArticlesByScope,
  createWikiArticle,
  deleteAllWikiArticlesForScope,
  deleteStaleWikiArticles,
  deleteWikiArticle,
  getWikiArticle,
  getWikiArticleBySlug,
  listAllWikiArticles,
  listWikiArticlesByScope,
  listWikiArticlesByScopeAndModule,
  updateWikiArticle,
} from "./wiki-articles"
import { bulkCreateWikiSections } from "./wiki-sections"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import type { WikiArticle } from "@/types/wiki"
import { SELF_CORPUS_ID } from "@/types/wiki"
import type { WikiArticleDraft } from "./wiki-articles"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

function makeDraft(overrides: Partial<WikiArticleDraft> = {}): WikiArticleDraft {
  return {
    slug: overrides.slug ?? "lib-foo",
    title: overrides.title ?? "lib/foo — overview",
    module: overrides.module ?? "lib/foo",
    scope: overrides.scope ?? "cognia-self",
    corpusId: overrides.corpusId ?? SELF_CORPUS_ID,
    pageRank: overrides.pageRank ?? 0.5,
    summary: overrides.summary ?? "summary text",
    sectionIds: overrides.sectionIds ?? [],
    sourceRefs: overrides.sourceRefs ?? [
      { filePath: "lib/foo/index.ts", lineStart: 1, lineEnd: 10, sha: "abc" },
    ],
    contentMd: overrides.contentMd ?? "# heading\n\nbody",
    embedding: overrides.embedding ?? [0.1, 0.2, 0.3],
    generatorVersion: overrides.generatorVersion ?? "v1",
    fileHashes: overrides.fileHashes ?? { "lib/foo/index.ts": "abc" },
    ...overrides,
  }
}

describe("wiki-articles CRUD", () => {
  it("creates and reads back an article", async () => {
    const created = await createWikiArticle(makeDraft())
    expect(created.id).toMatch(/^wka_/)
    expect(created.slug).toBe("lib-foo")
    expect(created.generatedAt).toBeGreaterThan(0)
    const fetched = await getWikiArticle(created.id)
    expect(fetched).toEqual(created)
  })

  it("honors caller-provided id and generatedAt", async () => {
    const row = await createWikiArticle(makeDraft({ id: "wka_custom", generatedAt: 1234 }))
    expect(row.id).toBe("wka_custom")
    expect(row.generatedAt).toBe(1234)
  })

  it("bulkCreateWikiArticles round-trips and short-circuits on empty input", async () => {
    const empty = await bulkCreateWikiArticles([])
    expect(empty).toEqual([])
    const rows = await bulkCreateWikiArticles([makeDraft({ slug: "a" }), makeDraft({ slug: "b" })])
    expect(rows).toHaveLength(2)
    const all = await listAllWikiArticles()
    expect(all).toHaveLength(2)
  })

  it("bulkCreate honors caller-supplied generatedAt", async () => {
    const [row] = await bulkCreateWikiArticles([makeDraft({ slug: "x", generatedAt: 9999 })])
    expect(row.generatedAt).toBe(9999)
  })

  it("getWikiArticleBySlug finds by slug index", async () => {
    await createWikiArticle(makeDraft({ slug: "needle" }))
    const found = await getWikiArticleBySlug(SELF_CORPUS_ID, "needle")
    expect(found?.slug).toBe("needle")
    const missing = await getWikiArticleBySlug(SELF_CORPUS_ID, "nope")
    expect(missing).toBeUndefined()
  })

  it("listWikiArticlesByScope filters by scope and orders by pageRank desc", async () => {
    await createWikiArticle(makeDraft({ slug: "a", scope: "cognia-self", pageRank: 0.1 }))
    await createWikiArticle(makeDraft({ slug: "b", scope: "cognia-self", pageRank: 0.9 }))
    await createWikiArticle(makeDraft({ slug: "c", scope: "user-repo", pageRank: 0.5 }))
    const cognia = await listWikiArticlesByScope("cognia-self")
    expect(cognia.map((a) => a.slug)).toEqual(["b", "a"])
    const userRepo = await listWikiArticlesByScope("user-repo")
    expect(userRepo).toHaveLength(1)
  })

  it("listWikiArticlesByScopeAndModule uses the composite index", async () => {
    await createWikiArticle(makeDraft({ slug: "twin1", module: "lib/twin", scope: "cognia-self" }))
    await createWikiArticle(makeDraft({ slug: "twin2", module: "lib/twin", scope: "cognia-self" }))
    await createWikiArticle(makeDraft({ slug: "rag", module: "lib/ai/rag", scope: "cognia-self" }))
    const twin = await listWikiArticlesByScopeAndModule("cognia-self", "lib/twin")
    expect(twin).toHaveLength(2)
    const empty = await listWikiArticlesByScopeAndModule("user-repo", "lib/twin")
    expect(empty).toEqual([])
  })

  it("countWikiArticlesByScope returns scope-restricted counts", async () => {
    await createWikiArticle(makeDraft({ slug: "a", scope: "cognia-self" }))
    await createWikiArticle(makeDraft({ slug: "b", scope: "cognia-self" }))
    await createWikiArticle(makeDraft({ slug: "c", scope: "user-repo" }))
    expect(await countWikiArticlesByScope("cognia-self")).toBe(2)
    expect(await countWikiArticlesByScope("user-repo")).toBe(1)
    expect(await countWikiArticlesByScope("runtime")).toBe(0)
  })

  it("updateWikiArticle merges patch and returns the updated row", async () => {
    const row = await createWikiArticle(makeDraft({ slug: "original" }))
    const updated = await updateWikiArticle(row.id, { summary: "patched" })
    expect(updated?.summary).toBe("patched")
    expect(updated?.slug).toBe("original")
  })

  it("deleteWikiArticle cascades to sections of that article", async () => {
    const article = await createWikiArticle(makeDraft({ slug: "with-sections" }))
    await bulkCreateWikiSections([
      {
        articleId: article.id,
        corpusId: SELF_CORPUS_ID,
        sectionIndex: 0,
        headingPath: ["intro"],
        bodyMd: "intro",
        sourceRefs: [],
      },
      {
        articleId: article.id,
        corpusId: SELF_CORPUS_ID,
        sectionIndex: 1,
        headingPath: ["details"],
        bodyMd: "details",
        sourceRefs: [],
      },
    ])
    expect(await getDb().wikiSections.where("articleId").equals(article.id).count()).toBe(2)
    await deleteWikiArticle(article.id)
    expect(await getWikiArticle(article.id)).toBeUndefined()
    expect(await getDb().wikiSections.where("articleId").equals(article.id).count()).toBe(0)
  })

  it("deleteAllWikiArticlesForScope wipes only that scope (with cascade)", async () => {
    const a = await createWikiArticle(makeDraft({ slug: "a", scope: "cognia-self" }))
    const b = await createWikiArticle(makeDraft({ slug: "b", scope: "cognia-self" }))
    await createWikiArticle(makeDraft({ slug: "c", scope: "user-repo" }))
    await bulkCreateWikiSections([
      {
        articleId: a.id,
        corpusId: SELF_CORPUS_ID,
        sectionIndex: 0,
        headingPath: ["x"],
        bodyMd: "x",
        sourceRefs: [],
      },
      {
        articleId: b.id,
        corpusId: SELF_CORPUS_ID,
        sectionIndex: 0,
        headingPath: ["y"],
        bodyMd: "y",
        sourceRefs: [],
      },
    ])
    const removed = await deleteAllWikiArticlesForScope("cognia-self")
    expect(removed).toBe(2)
    expect(await countWikiArticlesByScope("cognia-self")).toBe(0)
    expect(await countWikiArticlesByScope("user-repo")).toBe(1)
    expect(await getDb().wikiSections.count()).toBe(0)
  })

  it("deleteAllWikiArticlesForScope is a no-op for an empty scope", async () => {
    expect(await deleteAllWikiArticlesForScope("runtime")).toBe(0)
  })

  it("deleteStaleWikiArticles removes only mismatched-version rows", async () => {
    await createWikiArticle(makeDraft({ slug: "old1", generatorVersion: "v1" }))
    await createWikiArticle(makeDraft({ slug: "old2", generatorVersion: "v1" }))
    await createWikiArticle(makeDraft({ slug: "fresh", generatorVersion: "v2" }))
    const removed = await deleteStaleWikiArticles("cognia-self", "v2")
    expect(removed).toBe(2)
    const remaining = await listWikiArticlesByScope("cognia-self")
    expect(remaining.map((a) => a.slug)).toEqual(["fresh"])
  })

  it("deleteStaleWikiArticles is a no-op when nothing is stale", async () => {
    await createWikiArticle(makeDraft({ slug: "fresh", generatorVersion: "v2" }))
    expect(await deleteStaleWikiArticles("cognia-self", "v2")).toBe(0)
  })
})

describe("wiki-articles edge cases", () => {
  it("listAllWikiArticles spans every scope", async () => {
    await createWikiArticle(makeDraft({ slug: "a", scope: "cognia-self" }))
    await createWikiArticle(makeDraft({ slug: "b", scope: "user-repo" }))
    await createWikiArticle(makeDraft({ slug: "c", scope: "runtime" }))
    const all = await listAllWikiArticles()
    expect(all.map((a: WikiArticle) => a.scope).sort()).toEqual([
      "cognia-self",
      "runtime",
      "user-repo",
    ])
  })

  it("updateWikiArticle returns undefined for an unknown id", async () => {
    const result = await updateWikiArticle("wka_nope", { summary: "x" })
    expect(result).toBeUndefined()
  })
})
