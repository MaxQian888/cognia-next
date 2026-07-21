import { errorText, renderErrorCard, renderReportCard, renderResultCard } from "./render"
import type { DeepResearchResult, DeepSearchResult } from "./types"

function result(over: Partial<DeepSearchResult> = {}): DeepSearchResult {
  return {
    answer: "The answer is 42 [1].",
    citations: [{ url: "https://a.com", title: "A" }],
    knowledge: [],
    steps: [
      { step: 1, action: "search", detail: "" },
      { step: 2, action: "answer", detail: "" },
    ],
    usage: { totalTokens: 1234 },
    gaveUp: false,
    ...over,
  }
}

describe("renderResultCard", () => {
  it("renders question, answer, deduped sources and a footer", () => {
    const md = renderResultCard("what is the answer?", result())
    expect(md).toContain("Deep Research")
    expect(md).toContain("> what is the answer?")
    expect(md).toContain("The answer is 42 [1].")
    expect(md).toContain("[A](https://a.com)")
    expect(md).toContain("2 steps")
    expect(md).toContain("evidence-checked")
  })

  it("flags a gave-up result and omits an empty sources block", () => {
    const md = renderResultCard("q", result({ citations: [], gaveUp: true }))
    expect(md).toContain("budget limits")
    expect(md).not.toContain("**Sources**")
  })

  it("dedupes repeated citation urls", () => {
    const md = renderResultCard(
      "q",
      result({
        citations: [
          { url: "https://a.com", title: "A" },
          { url: "https://a.com", title: "A" },
        ],
      })
    )
    expect(md.match(/https:\/\/a\.com/g)).toHaveLength(1)
  })
})

describe("renderReportCard", () => {
  it("renders the report markdown with a section/token footer", () => {
    const report: DeepResearchResult = {
      topic: "t",
      title: "T",
      report: "# T\n\nbody\n\n## Sources\n1. [A](https://a.com)",
      outline: { title: "T", sections: [] },
      sections: [
        { heading: "H1", question: "q", answer: "a", citations: [], gaveUp: false },
        { heading: "H2", question: "q", answer: "a", citations: [], gaveUp: false },
      ],
      citations: [{ url: "https://a.com", title: "A" }],
      usage: { totalTokens: 999 },
    }
    const md = renderReportCard(report)
    expect(md).toContain("## Sources")
    expect(md).toContain("2 sections")
    expect(md).toContain("999")
  })
})

describe("renderErrorCard / errorText", () => {
  it("explains a missing provider", () => {
    expect(renderErrorCard({ ok: false, error: "NO_PROVIDER" })).toContain("AI model provider")
    expect(errorText({ ok: false, error: "NO_PROVIDER" })).toMatch(/provider/i)
  })
  it("explains a missing api key with the provider name", () => {
    expect(renderErrorCard({ ok: false, error: "MISSING_KEY", provider: "tavily" })).toContain(
      "tavily"
    )
    expect(errorText({ ok: false, error: "MISSING_KEY", provider: "tavily" })).toContain("tavily")
  })
  it("explains a declined AI permission distinctly from a missing provider", () => {
    const card = renderErrorCard({ ok: false, error: "NO_AI_PERMISSION" })
    expect(card).toContain("permission")
    expect(card).toContain("授权")
    // Must NOT be confused with "configure a provider" — the provider is fine,
    // the grant is missing, and the two need different user actions.
    expect(card).not.toContain("Configure a provider in settings")
    expect(errorText({ ok: false, error: "NO_AI_PERMISSION" })).toMatch(/ai:chat/)
  })
})
