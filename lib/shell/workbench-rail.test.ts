import {
  getWorkbenchRailCatalog,
  getWorkbenchRailCatalogWithPlugins,
  isDefaultWorkbenchRailLayout,
  isWorkbenchActivityHidden,
  resolveWorkbenchRailLayout,
  workbenchRailIndex,
  WORKBENCH_ACTIVITY_ICONS,
} from "./workbench-rail"
import {
  CANONICAL_CONTEXT_ACTIVITIES,
  CONTEXT_ACTIVITY_RAIL_ORDER,
} from "@/types/context-workbench"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { DEFAULT_WORKBENCH_RAIL_LAYOUT } from "@/types/shell/workbench-rail"

describe("workbench rail catalog", () => {
  it("covers exactly the canonical activities", () => {
    // The two lists are maintained separately (one alphabetical, one in rail
    // order). A member in one and not the other would either strand an activity
    // off the customizer or put a dead id in the stored layout.
    const catalogIds = getWorkbenchRailCatalog().map((i) => i.id)
    expect([...catalogIds].sort()).toEqual([...CANONICAL_CONTEXT_ACTIVITIES].sort())
  })

  it("is ordered like the rail, not alphabetically", () => {
    // Catalog order is what `resolveOrderedLayout` falls back to for ids a
    // stored layout never mentioned, so it has to be the rail's order.
    expect(getWorkbenchRailCatalog().map((i) => i.id)).toEqual([...CONTEXT_ACTIVITY_RAIL_ORDER])
  })

  it("maps every activity to a real icon", () => {
    for (const id of CANONICAL_CONTEXT_ACTIVITIES) {
      expect(WORKBENCH_ACTIVITY_ICONS[id]).toBeDefined()
    }
  })
})

describe("resolveWorkbenchRailLayout", () => {
  const catalog = getWorkbenchRailCatalog()

  it("honours a user order", () => {
    const resolved = resolveWorkbenchRailLayout(catalog, {
      order: ["workspace", "ai"],
      hidden: [],
    })
    // The two named ids lead; the rest follow in catalog order.
    expect(resolved.visible.slice(0, 2).map((i) => i.id)).toEqual(["workspace", "ai"])
    expect(resolved.visible).toHaveLength(catalog.length)
  })

  it("keeps a hidden activity's slot so unhiding restores it in place", () => {
    const resolved = resolveWorkbenchRailLayout(catalog, {
      order: [...CONTEXT_ACTIVITY_RAIL_ORDER],
      hidden: ["review"],
    })
    expect(resolved.hidden.map((i) => i.id)).toEqual(["review"])
    expect(resolved.visible.map((i) => i.id)).not.toContain("review")
    // Still second in the full order — where it was before it was hidden.
    expect(resolved.order.map((i) => i.id)[1]).toBe("review")
  })
})

describe("workbenchRailIndex", () => {
  it("sorts by the stored order", () => {
    const layout = { order: ["workspace", "preview-run", "ai"], hidden: [] }
    expect(workbenchRailIndex("workspace", layout)).toBeLessThan(
      workbenchRailIndex("preview-run", layout)
    )
  })

  it("sorts an unknown (plugin) activity after every named one", () => {
    const layout = DEFAULT_WORKBENCH_RAIL_LAYOUT
    // The guarantee a third-party panel relies on: it can never fall off the
    // rail just because the user reordered the built-ins.
    expect(workbenchRailIndex("acme:custom", layout)).toBe(layout.order.length)
    for (const id of layout.order) {
      expect(workbenchRailIndex(id, layout)).toBeLessThan(layout.order.length)
    }
  })
})

describe("isWorkbenchActivityHidden", () => {
  it("reports only the hidden set", () => {
    const layout = { order: [...CONTEXT_ACTIVITY_RAIL_ORDER], hidden: ["comments"] }
    expect(isWorkbenchActivityHidden("comments", layout)).toBe(true)
    expect(isWorkbenchActivityHidden("ai", layout)).toBe(false)
  })
})

describe("isDefaultWorkbenchRailLayout", () => {
  it("recognises the shipped layout", () => {
    expect(isDefaultWorkbenchRailLayout(DEFAULT_WORKBENCH_RAIL_LAYOUT)).toBe(true)
  })

  it("rejects a reorder or a hide", () => {
    expect(
      isDefaultWorkbenchRailLayout({
        order: [...DEFAULT_WORKBENCH_RAIL_LAYOUT.order].reverse(),
        hidden: [],
      })
    ).toBe(false)
    expect(
      isDefaultWorkbenchRailLayout({
        order: [...DEFAULT_WORKBENCH_RAIL_LAYOUT.order],
        hidden: ["ai"],
      })
    ).toBe(false)
  })
})

describe("getWorkbenchRailCatalogWithPlugins", () => {
  afterEach(() => {
    // Clean up any plugin registrations
    contextPanelRegistry.unregisterPlugin("test-plugin")
  })

  it("returns only canonical activities when no plugins are registered", () => {
    const catalog = getWorkbenchRailCatalogWithPlugins()
    expect(catalog.map((i) => i.id)).toEqual([...CONTEXT_ACTIVITY_RAIL_ORDER])
  })

  it("includes plugin activities not in the canonical set", () => {
    contextPanelRegistry.register({
      id: "test-plugin:custom-panel",
      activity: "custom-activity",
      labelKey: "test.label",
      appliesTo: () => true,
      renderer: () => null,
      pluginId: "test-plugin",
    })

    const catalog = getWorkbenchRailCatalogWithPlugins()
    const ids = catalog.map((i) => i.id)
    expect(ids).toContain("custom-activity")
    // Plugin activities are appended after canonical
    expect(ids.indexOf("custom-activity")).toBeGreaterThan(
      ids.indexOf(CONTEXT_ACTIVITY_RAIL_ORDER[CONTEXT_ACTIVITY_RAIL_ORDER.length - 1])
    )
  })

  it("does not duplicate canonical activities used by plugins", () => {
    contextPanelRegistry.register({
      id: "test-plugin:ai-panel",
      activity: "ai",
      labelKey: "test.label",
      appliesTo: () => true,
      renderer: () => null,
      pluginId: "test-plugin",
    })

    const catalog = getWorkbenchRailCatalogWithPlugins()
    const aiEntries = catalog.filter((i) => i.id === "ai")
    expect(aiEntries).toHaveLength(1)
  })

  it("carries the contributing panel's label so the customizer has something to show", () => {
    contextPanelRegistry.register({
      id: "test-plugin:custom-panel",
      activity: "custom-activity",
      labelKey: "panel.title",
      label: "Custom panel",
      appliesTo: () => true,
      renderer: () => null,
      pluginId: "test-plugin",
    })

    const entry = getWorkbenchRailCatalogWithPlugins().find((i) => i.id === "custom-activity")
    // Without these the customizer renders the raw
    // `contextWorkbench.activities.custom-activity` key: no such message
    // exists, and none can, because the id comes from a plugin.
    expect(entry).toMatchObject({
      label: "Custom panel",
      labelKey: "panel.title",
      pluginId: "test-plugin",
    })
  })

  it("leaves canonical activities without a literal label, so they stay translated", () => {
    const entry = getWorkbenchRailCatalogWithPlugins().find((i) => i.id === "inspect")
    expect(entry?.label).toBeUndefined()
    expect(entry?.pluginId).toBeUndefined()
  })

  it("removes plugin activities when the plugin is unregistered", () => {
    contextPanelRegistry.register({
      id: "test-plugin:custom-panel",
      activity: "ephemeral-activity",
      labelKey: "test.label",
      appliesTo: () => true,
      renderer: () => null,
      pluginId: "test-plugin",
    })

    expect(getWorkbenchRailCatalogWithPlugins().map((i) => i.id)).toContain("ephemeral-activity")

    contextPanelRegistry.unregisterPlugin("test-plugin")

    expect(getWorkbenchRailCatalogWithPlugins().map((i) => i.id)).not.toContain(
      "ephemeral-activity"
    )
  })
})
