jest.mock("@cognia/rag/query-expansion", () => ({
  expandWithSynonyms: jest.fn((s: string) => [s]),
}))

import { expandWithSynonyms } from "@cognia/rag/query-expansion"
import { buildExpandedKeywordQuery } from "./query-expansion"

const mockExpand = expandWithSynonyms as jest.MockedFunction<typeof expandWithSynonyms>

describe("buildExpandedKeywordQuery", () => {
  beforeEach(() => {
    mockExpand.mockReset()
    mockExpand.mockImplementation((s: string) => [s])
  })

  it("returns an empty string for blank input", () => {
    expect(buildExpandedKeywordQuery("   ")).toBe("")
    expect(mockExpand).not.toHaveBeenCalled()
  })

  it("returns the trimmed base unchanged when there are no variants", () => {
    mockExpand.mockReturnValue(["deploy the app"])
    expect(buildExpandedKeywordQuery("  deploy the app  ")).toBe("deploy the app")
  })

  it("appends NEW synonym terms from the variants", () => {
    mockExpand.mockReturnValue(["deploy app", "ship app", "release app"])
    const out = buildExpandedKeywordQuery("deploy app")
    expect(out.startsWith("deploy app ")).toBe(true)
    expect(out).toContain("ship")
    expect(out).toContain("release")
    // `app` already present in the base is not re-appended.
    expect(out.split(/\s+/).filter((t) => t === "app")).toHaveLength(1)
  })

  it("does not append terms already present in the base (case-insensitive)", () => {
    mockExpand.mockReturnValue(["Deploy App", "APP deploy"])
    expect(buildExpandedKeywordQuery("Deploy App")).toBe("Deploy App")
  })

  it("drops single-character variant tokens", () => {
    mockExpand.mockReturnValue(["cat", "a feline"])
    const out = buildExpandedKeywordQuery("cat")
    expect(out).toContain("feline")
    expect(out.split(/\s+/)).not.toContain("a")
  })
})
