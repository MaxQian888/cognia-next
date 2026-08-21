import { EMPTY_ISSUE_FILTER } from "./board-model"
import {
  collectActiveFilterChips,
  isFilterValueActive,
  removeFilterChip,
  setSoleFilterValue,
  toggleFilterValue,
} from "./filter-chips"

describe("collectActiveFilterChips", () => {
  it("returns nothing for an untouched filter", () => {
    expect(collectActiveFilterChips(EMPTY_ISSUE_FILTER)).toEqual([])
  })

  it("ignores a whitespace-only query, matching isIssueFilterActive", () => {
    expect(collectActiveFilterChips({ ...EMPTY_ISSUE_FILTER, query: "   " })).toEqual([])
  })

  it("trims the query it does surface", () => {
    expect(collectActiveFilterChips({ ...EMPTY_ISSUE_FILTER, query: "  auth " })).toEqual([
      { facet: "query", value: "auth", key: "query:auth" },
    ])
  })

  it("emits one chip per value, not one per facet", () => {
    const chips = collectActiveFilterChips({
      ...EMPTY_ISSUE_FILTER,
      priorities: ["urgent", "high"],
    })
    expect(chips.map((chip) => chip.value)).toEqual(["urgent", "high"])
  })

  it("keys chips uniquely across facets that share a value", () => {
    const chips = collectActiveFilterChips({
      ...EMPTY_ISSUE_FILTER,
      labelIds: ["x"],
      issueProjectIds: ["x"],
    })
    expect(new Set(chips.map((chip) => chip.key)).size).toBe(2)
  })

  it("orders facets the way the filter menu lists them", () => {
    const chips = collectActiveFilterChips({
      query: "q",
      priorities: ["low"],
      labelIds: ["l"],
      assignees: ["human:self"],
      sources: ["github"],
      issueProjectIds: ["p"],
    })
    expect(chips.map((chip) => chip.facet)).toEqual([
      "query",
      "priorities",
      "labelIds",
      "assignees",
      "sources",
      "issueProjectIds",
    ])
  })
})

describe("removeFilterChip", () => {
  it("clears the whole query facet", () => {
    const filter = { ...EMPTY_ISSUE_FILTER, query: "auth" }
    const [chip] = collectActiveFilterChips(filter)
    expect(removeFilterChip(filter, chip).query).toBe("")
  })

  it("removes only the named value from a multi-select facet", () => {
    const filter = { ...EMPTY_ISSUE_FILTER, priorities: ["urgent" as const, "low" as const] }
    const [urgent] = collectActiveFilterChips(filter)
    expect(removeFilterChip(filter, urgent).priorities).toEqual(["low"])
  })

  it("leaves every other facet untouched", () => {
    const filter = {
      ...EMPTY_ISSUE_FILTER,
      query: "auth",
      labelIds: ["l1"],
      sources: ["github" as const],
    }
    const [queryChip] = collectActiveFilterChips(filter)
    const next = removeFilterChip(filter, queryChip)
    expect(next.labelIds).toEqual(["l1"])
    expect(next.sources).toEqual(["github"])
  })

  it("does not mutate its input", () => {
    const filter = { ...EMPTY_ISSUE_FILTER, labelIds: ["l1", "l2"] }
    const [first] = collectActiveFilterChips(filter)
    removeFilterChip(filter, first)
    expect(filter.labelIds).toEqual(["l1", "l2"])
  })

  it("round-trips: removing every chip returns an inert filter", () => {
    let filter = {
      query: "q",
      priorities: ["low" as const],
      labelIds: ["l"],
      assignees: ["human:self"],
      sources: ["github" as const],
      issueProjectIds: ["p"],
    }
    for (const chip of collectActiveFilterChips(filter)) {
      filter = removeFilterChip(filter, chip) as typeof filter
    }
    expect(collectActiveFilterChips(filter)).toEqual([])
  })
})

describe("toggleFilterValue", () => {
  it("adds a value that was not engaged", () => {
    expect(toggleFilterValue(EMPTY_ISSUE_FILTER, "labelIds", "l1").labelIds).toEqual(["l1"])
  })

  it("removes a value that was", () => {
    const filter = { ...EMPTY_ISSUE_FILTER, labelIds: ["l1", "l2"] }
    expect(toggleFilterValue(filter, "labelIds", "l1").labelIds).toEqual(["l2"])
  })

  it("does not touch sibling facets", () => {
    const filter = { ...EMPTY_ISSUE_FILTER, priorities: ["urgent" as const] }
    expect(toggleFilterValue(filter, "labelIds", "l1").priorities).toEqual(["urgent"])
  })
})

describe("isFilterValueActive", () => {
  it("reports engaged and unengaged values", () => {
    const filter = { ...EMPTY_ISSUE_FILTER, issueProjectIds: ["p1"] }
    expect(isFilterValueActive(filter, "issueProjectIds", "p1")).toBe(true)
    expect(isFilterValueActive(filter, "issueProjectIds", "p2")).toBe(false)
  })
})

describe("setSoleFilterValue", () => {
  it("replaces rather than appends, so picking a project means only that project", () => {
    const filter = { ...EMPTY_ISSUE_FILTER, issueProjectIds: ["p1", "p2"] }
    expect(setSoleFilterValue(filter, "issueProjectIds", "p3").issueProjectIds).toEqual(["p3"])
  })

  it("clears the facet for a null value", () => {
    const filter = { ...EMPTY_ISSUE_FILTER, issueProjectIds: ["p1"] }
    expect(setSoleFilterValue(filter, "issueProjectIds", null).issueProjectIds).toEqual([])
  })
})
