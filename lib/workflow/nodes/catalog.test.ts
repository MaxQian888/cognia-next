import { NODE_CATALOG, groupedCatalog, nodeCatalogEntry, searchCatalog } from "./catalog"
import { WORKFLOW_NODE_KINDS } from "@/types/workflow/visual"

describe("NODE_CATALOG", () => {
  it("has one entry per known kind", () => {
    expect(NODE_CATALOG).toHaveLength(WORKFLOW_NODE_KINDS.length)
    const seen = new Set<string>()
    for (const e of NODE_CATALOG) {
      expect(seen.has(e.kind)).toBe(false)
      seen.add(e.kind)
      expect(e.label.length).toBeGreaterThan(0)
      expect(e.description.length).toBeGreaterThan(0)
      expect(e.iconName.length).toBeGreaterThan(0)
    }
  })

  it("each category has at least one entry", () => {
    const cats = new Set(NODE_CATALOG.map((e) => e.category))
    for (const required of ["trigger", "action", "ai", "flow", "data", "io", "annotation"]) {
      expect(cats.has(required as ReturnType<typeof nodeCatalogEntry>["category"])).toBe(true)
    }
  })
})

describe("nodeCatalogEntry", () => {
  it("returns a known entry for a known kind", () => {
    const e = nodeCatalogEntry("trigger.cron")
    expect(e.label).toBe("On schedule")
    expect(e.iconName).toBe("Clock")
  })

  it("synthesizes a stub entry for an unknown kind (plugin namespace)", () => {
    const e = nodeCatalogEntry("custom.thing.foo" as Parameters<typeof nodeCatalogEntry>[0])
    expect(e.label).toBe("custom.thing.foo")
    expect(e.iconName).toBe("Box")
  })
})

describe("groupedCatalog", () => {
  it("returns the categories in the canonical order", () => {
    const groups = groupedCatalog()
    expect(groups.map((g) => g.category)).toEqual([
      "trigger",
      "action",
      "ai",
      "flow",
      "data",
      "io",
      "annotation",
    ])
  })

  it("hides desktop-only entries when requested", () => {
    const groups = groupedCatalog({ includeDesktopOnly: false })
    const all = groups.flatMap((g) => g.entries)
    expect(all.some((e) => e.kind === "trigger.webhook")).toBe(false)
    expect(all.some((e) => e.kind === "trigger.manual")).toBe(true)
  })
})

describe("searchCatalog", () => {
  it("returns all entries when query is empty", () => {
    expect(searchCatalog("")).toHaveLength(WORKFLOW_NODE_KINDS.length)
  })

  it("ranks exact label match above contains-only", () => {
    const out = searchCatalog("cron")
    expect(out[0].kind).toBe("trigger.cron")
  })

  it("matches keywords (e.g., 'telegram' finds the connector kinds)", () => {
    const out = searchCatalog("telegram")
    expect(out.some((e) => e.kind === "trigger.connector.inbound")).toBe(true)
    expect(out.some((e) => e.kind === "action.connector.send")).toBe(true)
  })

  it("matches kind substring as a last-resort bucket", () => {
    const out = searchCatalog("ai.")
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((e) => e.kind.startsWith("ai."))).toBe(true)
  })
})
