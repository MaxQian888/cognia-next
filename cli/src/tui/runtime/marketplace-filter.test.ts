/**
 * @jest-environment node
 */
import {
  annotateInstallState,
  entryStatusBadge,
  filterMarketplace,
  isNewerVersion,
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

  it("leads with the install-state badge when installed", () => {
    expect(entryHint({ installRef: "x/y", name: "N", installed: true, enabled: true })).toBe(
      "✓ installed"
    )
    expect(
      entryHint({ installRef: "x/y", name: "N", installed: true, enabled: true, downloads: 5 })
    ).toBe("✓ installed · ⤓ 5")
  })
})

describe("entryStatusBadge", () => {
  it("is empty when not installed", () => {
    expect(entryStatusBadge({ installRef: "x/y", name: "N" })).toBe("")
    expect(entryStatusBadge({ installRef: "x/y", name: "N", installed: false })).toBe("")
  })
  it("prefers the update badge", () => {
    expect(
      entryStatusBadge({ installRef: "x/y", name: "N", installed: true, updatable: true })
    ).toBe("↑ update")
  })
  it("shows disabled when off", () => {
    expect(
      entryStatusBadge({ installRef: "x/y", name: "N", installed: true, enabled: false })
    ).toBe("○ disabled")
  })
  it("shows installed when on and current", () => {
    expect(entryStatusBadge({ installRef: "x/y", name: "N", installed: true, enabled: true })).toBe(
      "✓ installed"
    )
  })
})

describe("isNewerVersion", () => {
  it("compares dot-segmented numbers left to right", () => {
    expect(isNewerVersion("1.2.0", "1.1.9")).toBe(true)
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true)
    expect(isNewerVersion("1.0.1", "1.0.10")).toBe(false)
  })
  it("is false for equal or older versions", () => {
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false)
    expect(isNewerVersion("1.0.0", "1.1.0")).toBe(false)
  })
  it("treats non-numeric / missing segments as 0", () => {
    expect(isNewerVersion("1.2", "1")).toBe(true)
    expect(isNewerVersion("x.y", "0.0")).toBe(false)
  })
})

describe("annotateInstallState", () => {
  const catalog: MarketplaceBrowseEntry[] = [
    { installRef: "a/x@main", name: "Alpha", version: "2.0.0" },
    { installRef: "b/y", name: "Beta", version: "1.0.0" },
  ]
  it("flags installed entries by ref (ignoring the @pin) with enabled state", () => {
    const out = annotateInstallState(catalog, [
      { id: "alpha", repoRef: "a/x", version: "1.0.0", enabled: true },
    ])
    expect(out[0]).toMatchObject({
      installed: true,
      enabled: true,
      updatable: true,
      installedId: "alpha",
    })
    expect(out[1].installed).toBe(false)
    expect(out[1].installedId).toBeUndefined()
  })
  it("marks an up-to-date install as not updatable", () => {
    const out = annotateInstallState(
      [{ installRef: "b/y", name: "Beta", version: "1.0.0" }],
      [{ id: "beta", repoRef: "b/y", version: "1.0.0", enabled: false }]
    )
    expect(out[0]).toMatchObject({ installed: true, enabled: false, updatable: false })
  })
})
