import {
  DEFAULT_SUMMARY_CARD_ROWS,
  isSummaryCardRowShown,
  resolveSummaryCardRows,
} from "./session-summary-card"

describe("resolveSummaryCardRows", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(resolveSummaryCardRows(undefined)).toEqual(DEFAULT_SUMMARY_CARD_ROWS)
  })

  it("overlays stored rows and drops malformed values and unknown ids", () => {
    expect(
      resolveSummaryCardRows({
        rows: {
          changes: "never",
          progress: "always",
          sources: "sometimes",
          bogus: "always",
        } as never,
      })
    ).toEqual({
      progress: "always",
      needsYou: "auto",
      changes: "never",
      artifacts: "auto",
      sources: "always",
      sharing: "auto",
    })
  })

  it("never mutates the shipped defaults", () => {
    resolveSummaryCardRows({ rows: { changes: "never" } })
    expect(DEFAULT_SUMMARY_CARD_ROWS.changes).toBe("always")
  })
})

describe("isSummaryCardRowShown", () => {
  it.each([
    ["always", false, true],
    ["always", true, true],
    ["auto", true, true],
    ["auto", false, false],
    ["never", true, false],
  ] as const)("%s with content=%s → %s", (visibility, hasContent, shown) => {
    expect(isSummaryCardRowShown(visibility, hasContent)).toBe(shown)
  })
})
