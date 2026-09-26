import { buildAgentA2UICatalogSection } from "./agent-catalog-prompt"
import { DEFAULT_CATALOG_ID, clearRegistry, registerComponent } from "./catalog"

const Noop = (() => null) as never

describe("buildAgentA2UICatalogSection", () => {
  beforeEach(() => clearRegistry())

  it("lists the component types of a registered custom catalog", () => {
    registerComponent("StockTicker" as never, Noop, { catalogId: "financial" })
    registerComponent("CandleChart" as never, Noop, { catalogId: "financial" })

    const section = buildAgentA2UICatalogSection("financial")

    expect(section).toContain('"financial" component catalog')
    expect(section).toContain("CandleChart, StockTicker")
    expect(section).toContain("Leave `catalogId` out of createSurface")
  })

  it("adds nothing for no catalog, the standard one, or an unregistered id", () => {
    expect(buildAgentA2UICatalogSection(undefined)).toBeUndefined()
    expect(buildAgentA2UICatalogSection(DEFAULT_CATALOG_ID)).toBeUndefined()
    expect(buildAgentA2UICatalogSection("gone")).toBeUndefined()
  })
})
