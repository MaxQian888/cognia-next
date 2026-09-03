import en from "@/i18n/messages/en/conversationFilters.json"
import zh from "@/i18n/messages/zh-CN/conversationFilters.json"

import {
  CONVERSATION_FACET_FAMILIES,
  CONVERSATION_FACET_FAMILY_OF,
  defaultOpenFacetEntries,
  groupFacetSections,
  type FacetMenuEntry,
} from "./conversation-filter-families"

const section = (key: string, activeCount = 0) => ({ key, activeCount })

/** The order `useFacetSections` builds on a fully populated install. */
const FULL = [
  section("sort"),
  section("status"),
  section("location"),
  section("agent"),
  section("model"),
  section("activity"),
]

function keys(entries: FacetMenuEntry<{ key: string; activeCount: number }>[]) {
  return entries.map((entry) => `${entry.kind}:${entry.key}`)
}

describe("groupFacetSections", () => {
  it("turns six top-level rows into three", () => {
    expect(keys(groupFacetSections(FULL))).toEqual([
      "section:sort",
      "family:refine",
      "family:scope",
    ])
  })

  it("keeps a family where its first section stood, so nothing is reordered", () => {
    const entries = groupFacetSections(FULL)
    const refine = entries[1]
    if (refine?.kind !== "family") throw new Error("expected the refine family")
    // `status` and `activity` are two apart in the source order and land
    // together, at the earlier of the two positions.
    expect(refine.sections.map((s) => s.key)).toEqual(["status", "activity"])
  })

  it("rolls the nested counts up, so folding hides no active filter", () => {
    const entries = groupFacetSections([
      section("sort", 1),
      section("status", 2),
      section("activity", 1),
      section("location", 3),
      section("agent", 1),
    ])
    const refine = entries.find((e) => e.key === "refine")
    const scope = entries.find((e) => e.key === "scope")
    if (refine?.kind !== "family" || scope?.kind !== "family") {
      throw new Error("expected both families to survive the fold")
    }
    expect(refine.activeCount).toBe(3)
    expect(scope.activeCount).toBe(4)
  })

  it("collapses a one-section family back to the top level", () => {
    // An install with no teams and one provider: `scope` has only workspaces
    // and folders to offer, so nesting would charge a click for nothing.
    const entries = groupFacetSections([section("sort"), section("status"), section("location")])
    expect(keys(entries)).toEqual(["section:sort", "section:status", "section:location"])
  })

  it("drops a family with nothing in it", () => {
    expect(keys(groupFacetSections([section("sort")]))).toEqual(["section:sort"])
  })

  it("passes an unknown section through rather than swallowing it", () => {
    // A facet added without a family entry must still be reachable. The fold
    // is a presentation choice, never a filter on what exists.
    const entries = groupFacetSections([section("sort"), section("brand-new")])
    expect(keys(entries)).toEqual(["section:sort", "section:brand-new"])
  })

  it("has a family for every section the menu builds except sort", () => {
    for (const key of ["status", "activity", "location", "agent", "model"]) {
      expect(CONVERSATION_FACET_FAMILY_OF[key]).toBeDefined()
    }
    expect(CONVERSATION_FACET_FAMILY_OF.sort).toBeUndefined()
  })
})

describe("defaultOpenFacetEntries", () => {
  it("opens sort and the narrowing family, never an install-specific facet list", () => {
    expect(defaultOpenFacetEntries(groupFacetSections(FULL))).toEqual(["sort", "refine"])
  })

  it("opens a collapsed family's section when that is what took its place", () => {
    // `status` alone stands in for `refine`, and it is still what the user
    // arrived for. Matching on the surviving key alone would open the drawer on
    // sort and nothing else, which is a fold silently costing the user a row.
    const entries = groupFacetSections([section("sort"), section("status")])
    expect(defaultOpenFacetEntries(entries)).toEqual(["sort", "status"])
  })

  it("still leaves the scope facets folded when that family collapses", () => {
    // Their contents are install-specific and can run to dozens of rows, which
    // is the one thing a fresh menu must not open onto.
    const entries = groupFacetSections([section("sort"), section("status"), section("location")])
    expect(defaultOpenFacetEntries(entries)).toEqual(["sort", "status"])
  })
})

describe("family labels", () => {
  // `t(`families.${key}`)` is a dynamic key, and `lint:i18n` does not follow
  // those. Without this the menu would ship a family row reading
  // "families.scope" in one locale and nothing would fail.
  it.each(CONVERSATION_FACET_FAMILIES)("%s is named in both catalogues", (family) => {
    expect((en.families as Record<string, string>)[family]).toBeTruthy()
    expect((zh.families as Record<string, string>)[family]).toBeTruthy()
  })

  it("carries no label for a family nothing maps to", () => {
    const named = new Set(Object.keys(en.families as Record<string, string>))
    expect([...named].sort()).toEqual([...CONVERSATION_FACET_FAMILIES].sort())
  })
})
