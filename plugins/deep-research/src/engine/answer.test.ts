import type { AiBridge } from "../lib/ai"
import { DEFAULT_CONFIG } from "../types"
import { citationsFor, draftAnswer } from "./answer"
import { initState, type ResearchState } from "./workspace"

function stateWithKnowledge(): ResearchState {
  const s = initState("q", DEFAULT_CONFIG)
  s.knowledge.push({ url: "https://a.com", title: "A", content: "alpha" })
  s.knowledge.push({ url: "https://b.com", title: "B", content: "beta" })
  s.knowledge.push({ url: "https://c.com", title: "C", content: "gamma" })
  return s
}

describe("citationsFor", () => {
  it("maps used [n] markers to their sources", () => {
    const s = stateWithKnowledge()
    expect(citationsFor("Per [1] and [3], yes.", s)).toEqual([
      { url: "https://a.com", title: "A" },
      { url: "https://c.com", title: "C" },
    ])
  })

  it("ignores out-of-range markers", () => {
    const s = stateWithKnowledge()
    expect(citationsFor("see [9]", s)).toEqual(
      s.knowledge.map((k) => ({ url: k.url, title: k.title }))
    )
  })

  it("falls back to all sources when none are cited", () => {
    const s = stateWithKnowledge()
    expect(citationsFor("no markers here", s)).toHaveLength(3)
  })
})

describe("draftAnswer", () => {
  it("returns the model text, derived citations and tokens", async () => {
    const ai: AiBridge = {
      chat: async function* () {
        yield { content: "Answer grounded in [2].", usage: { totalTokens: 33 } }
      },
      embed: async () => [],
    }
    const { answer, citations, tokens } = await draftAnswer(stateWithKnowledge(), ai, false)
    expect(answer).toContain("[2]")
    expect(citations).toEqual([{ url: "https://b.com", title: "B" }])
    expect(tokens).toBe(33)
  })
})
