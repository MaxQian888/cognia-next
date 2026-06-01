import type { AiBridge } from "../lib/ai"
import { DEFAULT_CONFIG, type EngineDeps, type SearchHit } from "../types"
import { runReadStep } from "./read-step"
import { initState, type ResearchState } from "./workspace"

function hit(url: string, title = url): SearchHit {
  return { url, title, content: "snippet", score: 1 }
}

/** Orthogonal unit vector e_i, so distinct sources never look like duplicates. */
function orthonormal(i: number): number[] {
  const v = new Array(16).fill(0)
  v[i % 16] = 1
  return v
}

function deps(
  over: { read?: EngineDeps["read"]; embed?: AiBridge["embed"]; search?: EngineDeps["search"] } = {}
): EngineDeps {
  const ai: AiBridge = {
    chat: async function* () {},
    embed: over.embed ?? (async (t) => t.map((_, i) => orthonormal(i))),
  }
  return {
    ai,
    search: over.search ?? (async () => []),
    read: over.read ?? (async () => "content"),
    logger: { info: () => {}, warn: () => {} },
  }
}

function state(): ResearchState {
  const s = initState("q", { ...DEFAULT_CONFIG, readTopK: 2 })
  s.candidates.push(hit("https://a.com"), hit("https://b.com"), hit("https://c.com"))
  return s
}

describe("runReadStep", () => {
  it("reads requested urls, records knowledge, marks visited and removes candidates", async () => {
    const s = state()
    const read = jest.fn(async (url: string) => `body of ${url}`)
    const { added } = await runReadStep(["https://a.com"], s, deps({ read }), 2)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      url: "https://a.com",
      content: "body of https://a.com",
      question: "q",
    })
    expect(s.visitedUrls.has("https://a.com")).toBe(true)
    expect(s.candidates.find((c) => c.url === "https://a.com")).toBeUndefined()
  })

  it("falls back to the top of the candidate pool when no urls are requested", async () => {
    const s = state()
    const { added } = await runReadStep([], s, deps(), 2)
    expect(added.map((k) => k.url)).toEqual(["https://a.com", "https://b.com"]) // readTopK = 2
  })

  it("skips a url whose content is empty but still marks it visited", async () => {
    const s = state()
    const read = jest.fn(async () => "   ")
    const { added } = await runReadStep(["https://a.com"], s, deps({ read }), 2)
    expect(added).toHaveLength(0)
    expect(s.visitedUrls.has("https://a.com")).toBe(true)
  })

  it("skips a url whose read throws", async () => {
    const s = state()
    const read = jest.fn(async () => {
      throw new Error("fetch failed")
    })
    const { added } = await runReadStep(["https://a.com"], s, deps({ read }), 2)
    expect(added).toHaveLength(0)
    expect(s.candidates.find((c) => c.url === "https://a.com")).toBeUndefined()
  })

  it("drops semantically duplicate evidence", async () => {
    const s = state()
    const embed = jest.fn(async (texts: string[]) => texts.map(() => [1, 0])) // all identical
    const { added } = await runReadStep(["https://a.com", "https://b.com"], s, deps({ embed }), 2)
    expect(added).toHaveLength(1)
  })

  it("keeps evidence when embedding is unavailable", async () => {
    const s = state()
    const embed = async () => {
      throw new Error("no embed")
    }
    const { added } = await runReadStep(["https://a.com", "https://b.com"], s, deps({ embed }), 2)
    expect(added).toHaveLength(2)
  })
})
