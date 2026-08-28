import { errorText, renderErrorCard, renderReportCard, renderResultCard } from "./render"
import type { ResearchErrorCode } from "./errors"
import type { DeepResearchResult, DeepSearchResult } from "./types"

const ALL_CODES: ResearchErrorCode[] = [
  "NO_PROVIDER",
  "NO_AI_PERMISSION",
  "WEB_DISABLED",
  "NO_SEARCH_PROVIDER",
  "RATE_LIMITED",
  "BLOCKED",
  "TOOL_UNAVAILABLE",
  "FAILED",
]

const result: DeepSearchResult = {
  answer: "The answer.",
  citations: [
    { url: "https://a.test", title: "A" },
    { url: "https://a.test", title: "A duplicate" },
    { url: "https://b.test", title: "" },
  ],
  knowledge: [],
  steps: [{ step: 1, action: "search", detail: "q" }],
  usage: { totalTokens: 1234 },
  gaveUp: false,
}

describe("renderResultCard", () => {
  it("renders the answer, deduplicated sources and a footer", () => {
    const card = renderResultCard("Why?", result)
    expect(card).toContain("> Why?")
    expect(card).toContain("The answer.")
    expect(card).toContain("1. [A](https://a.test)")
    // The same URL cited twice is one source, not two.
    expect(card).not.toContain("A duplicate")
    expect(card).toContain("2. [https://b.test](https://b.test)")
    expect(card).toContain("1 steps · 1,234 tokens · ✓ evidence-checked")
  })

  it("flags an answer forced out by the budget", () => {
    expect(renderResultCard("Why?", { ...result, gaveUp: true })).toContain(
      "answered under budget limits"
    )
  })
})

describe("renderReportCard", () => {
  it("appends a section/token footer to the report body", () => {
    const report: DeepResearchResult = {
      topic: "T",
      title: "Title",
      report: "# Title\n\nBody",
      outline: { title: "Title", sections: [] },
      sections: [
        { heading: "H", question: "Q", answer: "A", citations: [], gaveUp: false },
        { heading: "H2", question: "Q2", answer: "A2", citations: [], gaveUp: false },
      ],
      citations: [],
      usage: { totalTokens: 99 },
    }
    const card = renderReportCard(report)
    expect(card).toContain("# Title")
    expect(card).toContain("2 sections · 99 tokens · deep research report")
  })
})

describe("failure surfaces", () => {
  it("has a distinct, actionable card for every code", () => {
    // A card that only says "something went wrong" costs the user a support
    // round-trip; each code below names a different thing to change.
    const cards = ALL_CODES.map((code) => renderErrorCard(code))
    expect(new Set(cards).size).toBe(ALL_CODES.length)
    for (const card of cards) expect(card.startsWith("⚠️")).toBe(true)
  })

  it("has a distinct one-line summary for every code", () => {
    const texts = ALL_CODES.map((code) => errorText(code))
    expect(new Set(texts).size).toBe(ALL_CODES.length)
  })

  it("names the specific setting to change", () => {
    expect(renderErrorCard("NO_SEARCH_PROVIDER")).toContain("Settings → Search")
    expect(renderErrorCard("WEB_DISABLED")).toContain("Enable web tools")
    expect(renderErrorCard("NO_PROVIDER")).toContain("model provider")
  })

  it("appends the raw detail only for the unclassified case", () => {
    // For a known code the card already says what to do; the underlying
    // message would just be noise. For FAILED it is the only clue there is.
    expect(renderErrorCard("FAILED", "socket hang up")).toContain("socket hang up")
    expect(renderErrorCard("WEB_DISABLED", "socket hang up")).not.toContain("socket hang up")
    expect(errorText("FAILED", "socket hang up")).toContain("socket hang up")
    expect(errorText("RATE_LIMITED", "socket hang up")).not.toContain("socket hang up")
  })

  it("keeps the bilingual guidance the app's other plugin surfaces use", () => {
    expect(renderErrorCard("NO_SEARCH_PROVIDER")).toContain("设置 → 搜索")
  })
})
