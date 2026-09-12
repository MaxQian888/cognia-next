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

  it("flags a cancelled run distinctly from a budget-forced one", () => {
    expect(renderResultCard("Why?", { ...result, gaveUp: true, aborted: true })).toContain(
      "cancelled — partial findings"
    )
  })

  it("shows a source's publication date when the provider reported one", () => {
    const dated: DeepSearchResult = {
      ...result,
      citations: [{ url: "https://a.test", title: "A", publishedDate: "2026-08-30" }],
    }
    expect(renderResultCard("Why?", dated)).toContain("[A](https://a.test) (2026-08-30)")
  })
})

describe("renderReportCard", () => {
  const report: DeepResearchResult = {
    topic: "T",
    title: "Title",
    report: "# Title\n\nBody",
    outline: {
      title: "Title",
      sections: [
        { heading: "H", question: "Q" },
        { heading: "H2", question: "Q2" },
      ],
    },
    sections: [
      { heading: "H", question: "Q", answer: "A", citations: [], gaveUp: false, steps: 4 },
      { heading: "H2", question: "Q2", answer: "A2", citations: [], gaveUp: false, steps: 5 },
    ],
    citations: [],
    usage: { totalTokens: 99 },
    gaveUp: false,
  }

  it("appends a section/token footer to the report body", () => {
    const card = renderReportCard(report)
    expect(card).toContain("# Title")
    expect(card).toContain("2 sections · 99 tokens · deep research report")
  })

  it("flags a partial report and shows ran/planned sections", () => {
    const partial: DeepResearchResult = {
      ...report,
      sections: report.sections.slice(0, 1),
      gaveUp: true,
    }
    const card = renderReportCard(partial)
    expect(card).toContain("1/2 sections")
    expect(card).toContain("⚠️ partial")
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
