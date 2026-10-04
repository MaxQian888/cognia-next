import {
  ARCHIVED_COLLAPSE_PREFIX,
  collapseKeyForView,
  collapseOverridesForView,
  paletteQueryForView,
} from "./conversation-archive-view"

describe("collapseKeyForView", () => {
  it("stores the active view's folds under the plain section key", () => {
    expect(collapseKeyForView("team:t1", "active")).toBe("team:t1")
  })

  it("stores the archive's folds under their own prefix", () => {
    expect(collapseKeyForView("team:t1", "archived")).toBe(`${ARCHIVED_COLLAPSE_PREFIX}team:t1`)
  })
})

describe("collapseOverridesForView", () => {
  const stored = {
    "team:t1": true,
    "workspace:w1": false,
    [`${ARCHIVED_COLLAPSE_PREFIX}team:t1`]: false,
    [`${ARCHIVED_COLLAPSE_PREFIX}team:t2`]: true,
  }

  it("hands the active view the stored map unchanged", () => {
    expect(collapseOverridesForView(stored, "active")).toBe(stored)
  })

  it("hands the archive only its own choices, unprefixed", () => {
    expect(collapseOverridesForView(stored, "archived")).toEqual({
      "team:t1": false,
      "team:t2": true,
    })
  })

  it("starts the archive from the defaults when it has no choices yet", () => {
    expect(collapseOverridesForView({ "team:t1": true }, "archived")).toEqual({})
  })
})

describe("paletteQueryForView", () => {
  it("passes the active view's words through, and nothing for an empty field", () => {
    expect(paletteQueryForView("  deploy  ", "active")).toBe("deploy")
    expect(paletteQueryForView("   ", "active")).toBeUndefined()
  })

  it("tells the palette to search the archive from the archive", () => {
    expect(paletteQueryForView("deploy", "archived")).toBe("is:archived deploy")
    expect(paletteQueryForView("", "archived")).toBe("is:archived")
  })
})
