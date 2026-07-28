import { icons } from "lucide-react"
import { resolveContextPanelIcon } from "./panel-icons"

describe("context panel icons", () => {
  it("resolves names from the complete lucide registry", () => {
    expect(resolveContextPanelIcon("SearchCode")).toBe(icons.SearchCode)
    expect(resolveContextPanelIcon("ChartNoAxesCombined")).toBe(icons.ChartNoAxesCombined)
  })

  it("resolves a declared name and leaves an omitted one undefined", () => {
    expect(resolveContextPanelIcon("Wrench")).toBe(icons.Wrench)
    expect(resolveContextPanelIcon(undefined)).toBeUndefined()
  })
})
