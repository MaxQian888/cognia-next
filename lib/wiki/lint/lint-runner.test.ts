import { runWikiLint } from "./lint-runner"
import { listWikiArticlesByScope } from "@/lib/db/wiki-articles"
import { upsertWikiLintResult } from "@/lib/db/wiki-lint-results"
import type { WikiArticle } from "@/types/wiki"

jest.mock("@/lib/db/wiki-articles", () => ({ listWikiArticlesByScope: jest.fn() }))
jest.mock("@/lib/db/wiki-lint-results", () => ({ upsertWikiLintResult: jest.fn() }))

const mockList = listWikiArticlesByScope as jest.Mock
const mockUpsert = upsertWikiLintResult as jest.Mock

function article(slug: string, contentMd: string): WikiArticle {
  return {
    id: `wka_${slug}`,
    slug,
    title: slug,
    module: `lib/${slug}`,
    scope: "cognia-self",
    pageRank: 0,
    summary: "",
    sectionIds: [],
    sourceRefs: [],
    contentMd,
    embedding: [],
    generatedAt: 0,
    generatorVersion: "1.0.0",
    fileHashes: {},
  }
}

beforeEach(() => jest.clearAllMocks())

describe("runWikiLint", () => {
  it("lints the scope's articles and persists the result", async () => {
    mockList.mockResolvedValue([article("a", "[[missing]]"), article("b", "[[a]]")])
    const result = await runWikiLint("cognia-self")
    expect(mockList).toHaveBeenCalledWith("cognia-self")
    expect(result.brokenLinks).toHaveLength(1)
    expect(mockUpsert).toHaveBeenCalledWith(result)
  })

  it("defaults to the cognia-self scope", async () => {
    mockList.mockResolvedValue([])
    const result = await runWikiLint()
    expect(mockList).toHaveBeenCalledWith("cognia-self")
    expect(result.articleCount).toBe(0)
  })
})
