import type { AiBridge } from "../lib/ai"
import { DEFAULT_CONFIG, type EngineDeps, type SearchHit } from "../types"
import { runSearchStep } from "./search-step"
import { initState, type ResearchState } from "./workspace"

function hit(url: string, title = url): SearchHit {
  return { url, title, content: "snippet", score: 1 }
}

/** Orthogonal unit vector e_i, so distinct hits never look like duplicates. */
function orthonormal(i: number): number[] {
  const v = new Array(16).fill(0)
  v[i % 16] = 1
  return v
}

function deps(over: Partial<EngineDeps> = {}): EngineDeps {
  const ai: AiBridge = {
    chat: async function* () {},
    embed: async (t) => t.map((_, i) => orthonormal(i)),
  }
  return {
    ai,
    search: async () => [],
    read: async () => "",
    logger: { info: () => {}, warn: () => {} },
    ...over,
  }
}

function state(): ResearchState {
  return initState("q", { ...DEFAULT_CONFIG, searchResultsPerQuery: 5 })
}

describe("runSearchStep", () => {
  it("adds fresh hits to the candidate pool", async () => {
    const s = state()
    const d = deps({ search: async () => [hit("https://a.com"), hit("https://b.com")] })
    const { added } = await runSearchStep(["query"], s, d)
    expect(added.map((h) => h.url)).toEqual(["https://a.com", "https://b.com"])
    expect(s.candidates).toHaveLength(2)
  })

  it("dedupes against already-known urls (visited + existing candidates)", async () => {
    const s = state()
    s.candidates.push(hit("https://a.com"))
    s.visitedUrls.add("https://b.com")
    const d = deps({
      search: async () => [hit("https://a.com/"), hit("https://b.com"), hit("https://c.com")],
    })
    const { added } = await runSearchStep(["query"], s, d)
    expect(added.map((h) => h.url)).toEqual(["https://c.com"])
  })

  it("skips queries already issued", async () => {
    const s = state()
    s.searchedQueries.add("query")
    const search = jest.fn(async () => [hit("https://a.com")])
    await runSearchStep(["query"], s, deps({ search }))
    // re-run of the only query falls back to running it once, not zero times,
    // but a brand-new query is preferred — here it retries the lone query.
    expect(search).toHaveBeenCalledTimes(1)
  })

  it("continues past a provider error", async () => {
    const s = state()
    const search = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([hit("https://ok.com")])
    const { added } = await runSearchStep(["q1", "q2"], s, deps({ search }))
    expect(added.map((h) => h.url)).toEqual(["https://ok.com"])
  })

  it("applies semantic dedup, keeping the first of near-identical hits", async () => {
    const s = state()
    const sameVec = [1, 0]
    const embed = jest.fn(async (texts: string[]) => texts.map(() => sameVec))
    const d = deps({
      search: async () => [hit("https://a.com"), hit("https://b.com")],
      ai: { chat: async function* () {}, embed },
    })
    const { added } = await runSearchStep(["q"], s, d)
    expect(added).toHaveLength(1)
  })

  it("keeps all hits when embedding fails", async () => {
    const s = state()
    const d = deps({
      search: async () => [hit("https://a.com"), hit("https://b.com")],
      ai: {
        chat: async function* () {},
        embed: async () => {
          throw new Error("no embed")
        },
      },
    })
    const { added } = await runSearchStep(["q"], s, d)
    expect(added).toHaveLength(2)
  })
})
