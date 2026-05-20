import {
  DEFAULT_DISCOVER_CATEGORY,
  DISCOVER_CATEGORIES,
  DISCOVER_GROUPS,
  getCategoriesByGroup,
  getCategory,
  isValidCategoryId,
  type DiscoverCategoryId,
} from "./categories"

describe("lib/discover/categories", () => {
  it("every entry has a unique id", () => {
    const ids = DISCOVER_CATEGORIES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("every entry's group is one of DISCOVER_GROUPS", () => {
    for (const cat of DISCOVER_CATEGORIES) {
      expect(DISCOVER_GROUPS).toContain(cat.group)
    }
  })

  it("default category is the first implemented one", () => {
    expect(DEFAULT_DISCOVER_CATEGORY).toBe(DISCOVER_CATEGORIES[0].id)
  })

  it("default category is itself a valid id", () => {
    expect(isValidCategoryId(DEFAULT_DISCOVER_CATEGORY)).toBe(true)
  })

  it("isValidCategoryId accepts every implemented id", () => {
    for (const cat of DISCOVER_CATEGORIES) {
      expect(isValidCategoryId(cat.id)).toBe(true)
    }
  })

  it("every union id is now part of the implemented registry", () => {
    // Phase 5 promoted twinIngest — there are no more reserved-but-unimplemented
    // ids in the union. If a future phase adds a new id, list it here and gate
    // it in DISCOVER_CATEGORIES.
    const reserved: DiscoverCategoryId[] = []
    for (const id of reserved) {
      expect(isValidCategoryId(id)).toBe(false)
    }
  })

  it("isValidCategoryId rejects non-string and unknown values", () => {
    expect(isValidCategoryId(null)).toBe(false)
    expect(isValidCategoryId(undefined)).toBe(false)
    expect(isValidCategoryId(123)).toBe(false)
    expect(isValidCategoryId("nope")).toBe(false)
    expect(isValidCategoryId("")).toBe(false)
  })

  it("getCategory returns the matching entry or undefined", () => {
    expect(getCategory("characters")).toEqual(
      expect.objectContaining({ id: "characters", group: "agents" })
    )
    expect(getCategory("mcpTools")).toEqual(
      expect.objectContaining({ id: "mcpTools", group: "extensions" })
    )
    // Phase 5 added twinIngest.
    expect(getCategory("twinIngest")).toEqual(
      expect.objectContaining({ id: "twinIngest", group: "twin" })
    )
  })

  it("getCategoriesByGroup partitions correctly", () => {
    const allFromGroups = DISCOVER_GROUPS.flatMap((g) => getCategoriesByGroup(g))
    expect(allFromGroups).toHaveLength(DISCOVER_CATEGORIES.length)
    const agents = getCategoriesByGroup("agents")
    expect(agents.map((c) => c.id)).toEqual(["characters", "teams", "skills"])
    const extensions = getCategoriesByGroup("extensions")
    expect(extensions.map((c) => c.id)).toEqual([
      "plugins",
      "mcpTools",
      "connectors",
      "ocrProviders",
    ])
    const templates = getCategoriesByGroup("templates")
    expect(templates.map((c) => c.id)).toEqual(["workflowTemplates"])
    const twin = getCategoriesByGroup("twin")
    expect(twin.map((c) => c.id)).toEqual(["twinIngest", "twinDrafts"])
  })
})
