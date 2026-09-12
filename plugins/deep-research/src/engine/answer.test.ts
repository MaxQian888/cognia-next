import { wrapUntrustedContent } from "@cognia/plugin-sdk"

import type { AiBridge } from "../lib/ai"
import { DEFAULT_CONFIG } from "../types"
import { alignCitations, draftAnswer, stripSourcesTail } from "./answer"
import { initState, type ResearchState } from "./workspace"

function stateWithKnowledge(): ResearchState {
  const s = initState("q", DEFAULT_CONFIG)
  s.knowledge.push({ url: "https://a.com", title: "A", content: "alpha" })
  s.knowledge.push({ url: "https://b.com", title: "B", content: "beta" })
  s.knowledge.push({ url: "https://c.com", title: "C", content: "gamma" })
  return s
}

describe("alignCitations", () => {
  it("renumbers used markers by first appearance so they match the citation list", () => {
    const s = stateWithKnowledge()
    const { answer, citations } = alignCitations("Per [3] and [1], yes. [3] again.", s)
    expect(answer).toBe("Per [1] and [2], yes. [1] again.")
    expect(citations).toEqual([
      { url: "https://c.com", title: "C" },
      { url: "https://a.com", title: "A" },
    ])
  })

  it("leaves out-of-range brackets alone — they are text, not citations", () => {
    const s = stateWithKnowledge()
    const { answer, citations } = alignCitations("In [2024] it grew; see [2].", s)
    expect(answer).toBe("In [2024] it grew; see [1].")
    expect(citations).toEqual([{ url: "https://b.com", title: "B" }])
  })

  it("falls back to all sources when nothing valid is cited", () => {
    const s = stateWithKnowledge()
    const { answer, citations } = alignCitations("no markers here", s)
    expect(answer).toBe("no markers here")
    expect(citations).toHaveLength(3)
  })

  it("carries the source's publication date into the citation", () => {
    const s = initState("q", DEFAULT_CONFIG)
    s.knowledge.push({
      url: "https://a.com",
      title: "A",
      content: "x",
      publishedDate: "2026-08-30",
    })
    const { citations } = alignCitations("per [1]", s)
    expect(citations).toEqual([{ url: "https://a.com", title: "A", publishedDate: "2026-08-30" }])
  })

  it("strips the untrusted banner from citation titles", () => {
    const s = initState("q", DEFAULT_CONFIG)
    s.knowledge.push({
      url: "https://a.com",
      title: wrapUntrustedContent("Injected Title"),
      content: "x",
    })
    const { citations } = alignCitations("per [1]", s)
    expect(citations).toEqual([{ url: "https://a.com", title: "Injected Title" }])
  })
})

describe("stripSourcesTail", () => {
  it("removes a trailing Sources list of [n]-style lines", () => {
    const text = "Body [1].\n\nSources:\n[1] https://a.com\n[2] https://b.com\n"
    expect(stripSourcesTail(text)).toBe("Body [1].")
  })

  it("removes heading and bold variants with dashed items", () => {
    const text = "Body.\n\n## Sources\n- [A](https://a.com)\n- [B](https://b.com)"
    expect(stripSourcesTail(text)).toBe("Body.")
  })

  it("keeps a Sources section that is not at the end", () => {
    const text = "## Sources\n- a\n\nMore prose follows."
    expect(stripSourcesTail(text)).toBe(text)
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
    expect(answer).toContain("[1]")
    expect(citations).toEqual([{ url: "https://b.com", title: "B" }])
    expect(tokens).toBe(33)
  })

  it("drops a model-written Sources tail so the card does not render two lists", async () => {
    const ai: AiBridge = {
      chat: async function* () {
        yield {
          content: "Answer [1].\n\nSources:\n[1] https://a.com",
          usage: { totalTokens: 9 },
        }
      },
      embed: async () => [],
    }
    const { answer } = await draftAnswer(stateWithKnowledge(), ai, false)
    expect(answer).toBe("Answer [1].")
  })
})
