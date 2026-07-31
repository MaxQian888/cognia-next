import { collectReferencedSlugs, lintWikiArticles } from "./wiki-lint"
import type { WikiArticle } from "@/types/wiki"

function article(slug: string, contentMd: string, over: Partial<WikiArticle> = {}): WikiArticle {
  return {
    id: `wka_${slug}`,
    slug,
    title: `Article ${slug}`,
    module: `lib/${slug}`,
    scope: "cognia-self",
    pageRank: 0.5,
    summary: "",
    sectionIds: [],
    sourceRefs: [],
    contentMd,
    embedding: [],
    generatedAt: 0,
    generatorVersion: "1.0.0",
    fileHashes: {},
    ...over,
  }
}

describe("collectReferencedSlugs", () => {
  it("returns distinct link targets", () => {
    expect(collectReferencedSlugs("see [[a]] and [[b]] and [[a]]")).toEqual(["a", "b"])
  })

  it("returns empty for a body with no links", () => {
    expect(collectReferencedSlugs("no links here")).toEqual([])
  })
})

describe("lintWikiArticles", () => {
  it("flags articles with dangling links", () => {
    const articles = [article("a", "points to [[missing]]"), article("b", "[[a]]")]
    const r = lintWikiArticles("cognia-self", articles, 123)
    expect(r.brokenLinks).toEqual([{ slug: "a", title: "Article a", deadLinks: ["missing"] }])
    expect(r.lastRunAt).toBe(123)
    expect(r.articleCount).toBe(2)
  })

  it("flags orphan pages (no inbound links)", () => {
    // a → b (b linked), a is orphan (nobody links a).
    const articles = [article("a", "[[b]]"), article("b", "leaf")]
    const r = lintWikiArticles("cognia-self", articles, 0)
    expect(r.orphans.map((o) => o.slug)).toEqual(["a"])
  })

  it("does not let a self-reference rescue an orphan", () => {
    const articles = [article("c", "I link [[c]] myself")]
    const r = lintWikiArticles("cognia-self", articles, 0)
    expect(r.orphans.map((o) => o.slug)).toEqual(["c"])
    // Self-links to an existing slug are not broken.
    expect(r.brokenLinks).toEqual([])
  })

  it("reports a clean wiki when every page is linked and resolvable", () => {
    const articles = [article("a", "[[b]]"), article("b", "[[a]]")]
    const r = lintWikiArticles("cognia-self", articles, 0)
    expect(r.brokenLinks).toEqual([])
    expect(r.orphans).toEqual([])
  })
})
