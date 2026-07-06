import { buildExpandedKeywordQuery } from "./query-expansion"

describe("buildExpandedKeywordQuery", () => {
  it("returns blank input unchanged", () => {
    expect(buildExpandedKeywordQuery("")).toBe("")
    expect(buildExpandedKeywordQuery("   ")).toBe("")
  })

  it("keeps the original phrasing as a prefix", () => {
    const out = buildExpandedKeywordQuery("delete a record")
    expect(out.startsWith("delete a record")).toBe(true)
  })

  it("appends only NEW synonym terms (never duplicates base terms)", () => {
    const out = buildExpandedKeywordQuery("remove the record")
    const appended = out.slice("remove the record".length).trim().split(/\s+/).filter(Boolean)
    for (const term of appended) {
      expect(["remove", "the", "record"]).not.toContain(term.toLowerCase())
    }
  })

  it("returns the trimmed base when there are no synonyms to add", () => {
    // A nonsense token has no synonym mapping → nothing appended.
    expect(buildExpandedKeywordQuery("  zzzqqx  ")).toBe("zzzqqx")
  })
})
