/**
 * @jest-environment node
 */
import {
  filterMarketplace,
  nextSection,
  entryHint,
  MARKETPLACE_SECTIONS,
  type MarketplaceBrowseEntry,
} from "./marketplace-filter"

const entries: MarketplaceBrowseEntry[] = [
  {
    installRef: "a/x",
    name: "Alpha",
    description: "first",
    downloads: 10,
    rating: 4.5,
    signed: true,
    author: "amy",
  },
  { installRef: "b/y", name: "Beta", description: "second", downloads: 100, author: "ben" },
  { installRef: "c/z", name: "Gamma", description: "third", rating: 3.0, signed: false },
]

describe("filterMarketplace", () => {
  it("filters by a case-insensitive query over name/description/author/ref", () => {
    expect(filterMarketplace(entries, "alpha", "all").map((e) => e.name)).toEqual(["Alpha"])
    expect(filterMarketplace(entries, "ben", "all").map((e) => e.name)).toEqual(["Beta"])
    expect(filterMarketplace(entries, "c/z", "all").map((e) => e.name)).toEqual(["Gamma"])
  })

  it("popular sorts by downloads desc", () => {
    expect(filterMarketplace(entries, "", "popular").map((e) => e.name)).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ])
  })

  it("top-rated keeps only rated entries, sorted desc", () => {
    expect(filterMarketplace(entries, "", "top-rated").map((e) => e.name)).toEqual([
      "Alpha",
      "Gamma",
    ])
  })

  it("signed keeps only signed entries", () => {
    expect(filterMarketplace(entries, "", "signed").map((e) => e.name)).toEqual(["Alpha"])
  })

  it("all preserves order", () => {
    expect(filterMarketplace(entries, "", "all").map((e) => e.name)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ])
  })
})

describe("nextSection", () => {
  it("cycles through every section and wraps", () => {
    let s = MARKETPLACE_SECTIONS[0]
    const seen = [s]
    for (let i = 0; i < MARKETPLACE_SECTIONS.length; i++) {
      s = nextSection(s)
      seen.push(s)
    }
    expect(seen).toEqual([...MARKETPLACE_SECTIONS, MARKETPLACE_SECTIONS[0]])
  })
})

describe("entryHint", () => {
  it("summarizes rating, downloads, signed and author", () => {
    expect(entryHint(entries[0])).toBe("★ 4.5 · ⤓ 10 · signed · by amy")
  })

  it("falls back to description then installRef", () => {
    expect(entryHint({ installRef: "x/y", name: "N", description: "desc" })).toBe("desc")
    expect(entryHint({ installRef: "x/y", name: "N" })).toBe("x/y")
  })
})
