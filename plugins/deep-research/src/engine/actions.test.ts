import type { AiBridge } from "../lib/ai"
import { DEFAULT_CONFIG, type SearchHit } from "../types"
import { decideNextAction, heuristicDecision, normalizeDecision } from "./actions"
import { initState, type ResearchState } from "./workspace"

function hit(url: string, title = "t"): SearchHit {
  return { url, title, content: "snippet", score: 1 }
}

function withState(over: Partial<ResearchState> = {}): ResearchState {
  return { ...initState("the question", { ...DEFAULT_CONFIG, readTopK: 2 }), ...over }
}

function aiReturning(text: string): AiBridge {
  return {
    chat: async function* () {
      yield { content: text, usage: { totalTokens: 7 } }
    },
    embed: async (t) => t.map(() => [0]),
  }
}

describe("normalizeDecision", () => {
  it("keeps a well-formed read decision but filters urls to known candidates", () => {
    const s = withState({ candidates: [hit("https://a.com")] })
    const d = normalizeDecision(
      { action: "read", urls: ["https://a.com", "https://unknown.com"] },
      s,
      true
    )
    expect(d.action).toBe("read")
    expect(d.urls).toEqual(["https://a.com"])
  })

  it("coerces answer→read when answering is disallowed and candidates exist", () => {
    const s = withState({ candidates: [hit("https://a.com")] })
    const d = normalizeDecision({ action: "answer" }, s, false)
    expect(d.action).toBe("read")
    expect(d.urls).toEqual(["https://a.com"])
  })

  it("coerces answer→search when disallowed and no candidates", () => {
    const d = normalizeDecision({ action: "answer" }, withState(), false)
    expect(d.action).toBe("search")
    expect(d.queries).toEqual(["the question"])
  })

  it("fills missing search queries from the gap queue", () => {
    const s = withState({ gapQueue: ["sub question"] })
    const d = normalizeDecision({ action: "search" }, s, true)
    expect(d.queries).toEqual(["sub question"])
  })

  it("pivots read→search when no candidates are available", () => {
    const d = normalizeDecision({ action: "read", urls: [] }, withState(), true)
    expect(d.action).toBe("search")
  })

  it("repairs an empty reflect into read/search", () => {
    const withCands = normalizeDecision(
      { action: "reflect", gaps: [] },
      withState({ candidates: [hit("https://a.com")] }),
      true
    )
    expect(withCands.action).toBe("read")
    const noCands = normalizeDecision({ action: "reflect", gaps: [] }, withState(), true)
    expect(noCands.action).toBe("search")
  })

  it("falls back to a heuristic action for an invalid action string", () => {
    const d = normalizeDecision({ action: "frobnicate" }, withState(), true)
    expect(["search", "read", "answer"]).toContain(d.action)
  })
})

describe("heuristicDecision", () => {
  it("reads when candidates exist", () => {
    const s = withState({
      candidates: [hit("https://a.com"), hit("https://b.com"), hit("https://c.com")],
    })
    const d = heuristicDecision(s, true)
    expect(d.action).toBe("read")
    expect(d.urls).toHaveLength(2) // readTopK
  })
  it("answers when allowed and knowledge exists", () => {
    const s = withState({ knowledge: [{ url: "u", title: "t", content: "c" }] })
    expect(heuristicDecision(s, true).action).toBe("answer")
  })
  it("searches otherwise", () => {
    expect(heuristicDecision(withState(), false).action).toBe("search")
  })
})

describe("decideNextAction", () => {
  it("parses a model decision and returns its tokens", async () => {
    const s = withState({ candidates: [hit("https://a.com")] })
    const { decision, tokens } = await decideNextAction(
      s,
      aiReturning('{"action":"read","urls":["https://a.com"]}')
    )
    expect(decision.action).toBe("read")
    expect(tokens).toBe(7)
  })

  it("falls back to the heuristic on unparseable output", async () => {
    const s = withState({ candidates: [hit("https://a.com")] })
    const { decision, tokens } = await decideNextAction(
      s,
      aiReturning("I think we should read more")
    )
    expect(decision.action).toBe("read")
    expect(tokens).toBe(0)
  })
})

describe("normalizeDecision optional-key shape", () => {
  // `exactOptionalPropertyTypes`: a present `rationale: undefined` is a
  // DIFFERENT type from an absent key, and plugin authors compile against the
  // packed SDK with that flag on. `toEqual` cannot see the difference, so these
  // assert on key presence.
  it("omits rationale rather than setting it to undefined", () => {
    const d = normalizeDecision({ action: "search", queries: ["q"] }, withState(), true)
    expect("rationale" in d).toBe(false)
  })

  it("omits it on the read -> search pivot as well", () => {
    const d = normalizeDecision({ action: "read" }, withState({ candidates: [] }), true)
    expect(d.action).toBe("search")
    expect("rationale" in d).toBe(false)
  })

  it("still carries a rationale the model supplied", () => {
    const d = normalizeDecision(
      { action: "search", queries: ["q"], rationale: "because" },
      withState(),
      true
    )
    expect(d.rationale).toBe("because")
  })
})
