import {
  DEFAULT_DISCOVER_CATEGORY,
  DEFAULT_DISCOVER_LAYOUT,
  DISCOVER_CATEGORIES,
  DISCOVER_GROUPS,
  DISCOVER_VIEW_MODES,
  FAVORITES_CATEGORY,
  FORYOU_CATEGORY,
  firstVisibleCategory,
  getCategoriesByGroup,
  getCategory,
  isFavoritesView,
  isForYouView,
  isValidCategoryId,
  isValidView,
  isValidViewMode,
  resolveDiscoverLayout,
  resolveLandingCategory,
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
    expect(agents.map((c) => c.id)).toEqual([
      "characters",
      "teams",
      "skills",
      "teamTemplates",
      "agentPresets",
    ])
    const extensions = getCategoriesByGroup("extensions")
    expect(extensions.map((c) => c.id)).toEqual([
      "plugins",
      "mcpTools",
      "mcpPresets",
      "connectors",
      "docsProviders",
      "externalServices",
      "integrations",
      "ocrProviders",
      "slashCommands",
    ])
    const templates = getCategoriesByGroup("templates")
    expect(templates.map((c) => c.id)).toEqual(["workflowTemplates"])
    const twin = getCategoriesByGroup("twin")
    expect(twin.map((c) => c.id)).toEqual(["twinIngest", "twinDrafts"])
  })

  describe("view modes", () => {
    it("isValidViewMode accepts every mode and rejects others", () => {
      for (const mode of DISCOVER_VIEW_MODES) {
        expect(isValidViewMode(mode)).toBe(true)
      }
      expect(isValidViewMode("table")).toBe(false)
      expect(isValidViewMode(null)).toBe(false)
      expect(isValidViewMode(undefined)).toBe(false)
    })
  })

  describe("favorites pseudo-category", () => {
    it("is not part of the real registry", () => {
      expect(DISCOVER_CATEGORIES.some((c) => c.id === (FAVORITES_CATEGORY as string))).toBe(false)
      expect(isValidCategoryId(FAVORITES_CATEGORY)).toBe(false)
    })

    it("isFavoritesView only matches the sentinel", () => {
      expect(isFavoritesView(FAVORITES_CATEGORY)).toBe(true)
      expect(isFavoritesView("characters")).toBe(false)
    })

    it("isValidView accepts real ids and the favorites sentinel", () => {
      expect(isValidView("characters")).toBe(true)
      expect(isValidView(FAVORITES_CATEGORY)).toBe(true)
      expect(isValidView("nope")).toBe(false)
    })
  })

  describe("category layout", () => {
    it("default layout leaves every category in overflow in registry order", () => {
      const { pinned, overflow, hidden } = resolveDiscoverLayout(DEFAULT_DISCOVER_LAYOUT)
      expect(pinned).toEqual([])
      expect(hidden).toEqual([])
      expect(overflow.map((c) => c.id)).toEqual(DISCOVER_CATEGORIES.map((c) => c.id))
    })

    it("honors pinned order and hidden set", () => {
      const { pinned, hidden } = resolveDiscoverLayout({
        pinned: ["skills", "characters"],
        hidden: ["twinDrafts"],
      })
      expect(pinned.map((c) => c.id)).toEqual(["skills", "characters"])
      expect(hidden.map((c) => c.id)).toEqual(["twinDrafts"])
    })

    it("firstVisibleCategory prefers the first pinned, then overflow", () => {
      expect(firstVisibleCategory(DEFAULT_DISCOVER_LAYOUT)).toBe(DEFAULT_DISCOVER_CATEGORY)
      expect(firstVisibleCategory({ pinned: ["plugins"], hidden: [] })).toBe("plugins")
    })

    it("firstVisibleCategory skips hidden categories", () => {
      const first = DISCOVER_CATEGORIES[0].id
      const result = firstVisibleCategory({ pinned: [], hidden: [first] })
      expect(result).not.toBe(first)
      expect(isValidCategoryId(result)).toBe(true)
    })
  })

  describe("resolveLandingCategory", () => {
    it("falls back to the foryou aggregated landing when preference is unset", () => {
      expect(resolveLandingCategory(null, DEFAULT_DISCOVER_LAYOUT)).toBe(FORYOU_CATEGORY)
      // The default landing is foryou regardless of pinned layout.
      expect(resolveLandingCategory(undefined, { pinned: ["plugins"], hidden: [] })).toBe(
        FORYOU_CATEGORY
      )
    })

    it("always honours the foryou pseudo-category", () => {
      expect(resolveLandingCategory(FORYOU_CATEGORY, DEFAULT_DISCOVER_LAYOUT)).toBe(FORYOU_CATEGORY)
    })

    it("always honours the favorites pseudo-category", () => {
      expect(resolveLandingCategory(FAVORITES_CATEGORY, DEFAULT_DISCOVER_LAYOUT)).toBe(
        FAVORITES_CATEGORY
      )
    })

    it("honours a visible category preference", () => {
      expect(resolveLandingCategory("skills", DEFAULT_DISCOVER_LAYOUT)).toBe("skills")
    })

    it("ignores a hidden category preference and falls back to foryou", () => {
      const result = resolveLandingCategory("skills", { pinned: [], hidden: ["skills"] })
      expect(result).toBe(FORYOU_CATEGORY)
    })

    it("ignores an invalid preference and falls back to foryou", () => {
      expect(resolveLandingCategory("nonsense" as never, DEFAULT_DISCOVER_LAYOUT)).toBe(
        FORYOU_CATEGORY
      )
    })
  })

  describe("foryou pseudo-category", () => {
    it("is not part of the real registry", () => {
      expect(DISCOVER_CATEGORIES.some((c) => c.id === (FORYOU_CATEGORY as string))).toBe(false)
      expect(isValidCategoryId(FORYOU_CATEGORY)).toBe(false)
    })

    it("isForYouView only matches the sentinel", () => {
      expect(isForYouView(FORYOU_CATEGORY)).toBe(true)
      expect(isForYouView(FAVORITES_CATEGORY)).toBe(false)
      expect(isForYouView("characters")).toBe(false)
    })

    it("isValidView accepts foryou, favorites and real ids", () => {
      expect(isValidView(FORYOU_CATEGORY)).toBe(true)
      expect(isValidView(FAVORITES_CATEGORY)).toBe(true)
      expect(isValidView("teamTemplates")).toBe(true)
      expect(isValidView("agentPresets")).toBe(true)
      expect(isValidView("mcpPresets")).toBe(true)
      expect(isValidView("slashCommands")).toBe(true)
      expect(isValidView("nope")).toBe(false)
    })
  })
})

/**
 * The sidebar, the chip strip and the inspector header all label a category
 * with `t(`categories.${id}`)`, and the grid picks its empty state from
 * `EMPTY_KEY_BY_CATEGORY`. Both are template / table lookups that `lint:i18n`
 * cannot follow, so adding a category without its copy renders a raw key path
 * at people. Pin the catalogue against the registry instead.
 */
describe("discover category i18n catalogue", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const en = require("@/i18n/messages/en/discover.json") as Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zh = require("@/i18n/messages/zh-CN/discover.json") as Record<string, unknown>

  it.each(["en", "zh-CN"])("labels every registered category in %s", (locale) => {
    const labels = ((locale === "en" ? en : zh).categories ?? {}) as Record<string, string>
    for (const category of DISCOVER_CATEGORIES) {
      expect(typeof labels[category.id]).toBe("string")
      expect(labels[category.id]).not.toBe("")
    }
  })

  it.each(["en", "zh-CN"])("labels both pseudo-categories in %s", (locale) => {
    const labels = ((locale === "en" ? en : zh).categories ?? {}) as Record<string, string>
    expect(typeof labels[FAVORITES_CATEGORY]).toBe("string")
    expect(typeof labels[FORYOU_CATEGORY]).toBe("string")
  })

  it.each(["en", "zh-CN"])("gives every category an empty state in %s", (locale) => {
    const messages = locale === "en" ? en : zh
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EMPTY_KEY_BY_CATEGORY } = require("@/components/discover/discover-grid") as {
      EMPTY_KEY_BY_CATEGORY: Record<string, string | undefined>
    }
    for (const category of DISCOVER_CATEGORIES) {
      const key = EMPTY_KEY_BY_CATEGORY[category.id]
      expect(key).toBeDefined()
      expect(typeof messages[key as string]).toBe("string")
    }
  })
})
