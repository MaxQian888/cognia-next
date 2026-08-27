import { getLucideIcon } from "@/lib/icons/lucide-catalog"
import { resolveContextPanelIcon } from "./panel-icons"

// The oracle is the catalog, not `lucide-react`: icons are rebuilt from
// generated node data, so a resolved icon is the catalog's component and never
// identical to the barrel's. `lib/icons/lucide-catalog.test.tsx` is what pins
// the two to render the same thing.
describe("context panel icons", () => {
  it("resolves names from the complete lucide registry", () => {
    expect(resolveContextPanelIcon("SearchCode")).toBe(getLucideIcon("SearchCode"))
    expect(resolveContextPanelIcon("ChartNoAxesCombined")).toBe(
      getLucideIcon("ChartNoAxesCombined")
    )
  })

  it("resolves a declared name and leaves an omitted one undefined", () => {
    expect(resolveContextPanelIcon("Wrench")).toBe(getLucideIcon("Wrench"))
    expect(resolveContextPanelIcon(undefined)).toBeUndefined()
  })

  it("resolves every spelling the manifest validator admits", () => {
    // The kebab-case name the retired `PLUGIN_CONTEXT_PANEL_ICONS` allowlist
    // published, and an export alias lucide kept across a rename — both pass
    // validation, so both have to draw.
    expect(resolveContextPanelIcon("search-code")).toBe(getLucideIcon("SearchCode"))
    expect(resolveContextPanelIcon("history")).toBe(getLucideIcon("RotateCcwClock"))
    expect(resolveContextPanelIcon("History")).toBe(getLucideIcon("RotateCcwClock"))
  })

  it("leaves a name that is no icon at all undefined", () => {
    expect(resolveContextPanelIcon("NotARealLucideIcon")).toBeUndefined()
  })
})
