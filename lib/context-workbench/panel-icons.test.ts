import { CONTEXT_PANEL_ICONS, resolveContextPanelIcon } from "./panel-icons"
import { PLUGIN_CONTEXT_PANEL_ICONS } from "@/types/plugin/plugin-context-panel"

describe("context panel icons", () => {
  it("maps every declared icon name to a component", () => {
    // The map is typed as an exhaustive Record, so this guards the other
    // direction: a name added to the map but not to the shared list would make
    // the manifest validator reject an icon the host can actually render.
    expect(Object.keys(CONTEXT_PANEL_ICONS).sort()).toEqual([...PLUGIN_CONTEXT_PANEL_ICONS].sort())
    for (const name of PLUGIN_CONTEXT_PANEL_ICONS) {
      expect(typeof CONTEXT_PANEL_ICONS[name]).not.toBe("undefined")
    }
  })

  it("resolves a declared name and leaves an omitted one undefined", () => {
    expect(resolveContextPanelIcon("wrench")).toBe(CONTEXT_PANEL_ICONS.wrench)
    expect(resolveContextPanelIcon(undefined)).toBeUndefined()
  })
})
