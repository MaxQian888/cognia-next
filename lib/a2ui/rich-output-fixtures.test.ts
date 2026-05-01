import { richOutputFixtures, getRichOutputFixture } from "./rich-output-fixtures"

describe("rich output fixtures", () => {
  it("provides representative fixtures for core output categories", () => {
    expect(richOutputFixtures.directResponse.profileId).toBe("quick-factual-answer")
    expect(richOutputFixtures.svgDiagram.profileId).toBe("how-it-works-physical")
    expect(richOutputFixtures.mermaidSchema.profileId).toBe("database-schema-erd")
    expect(richOutputFixtures.htmlDashboard.profileId).toBe("kpis-metrics")
  })

  it("can look up a fixture by key", () => {
    expect(getRichOutputFixture("svgDiagram")?.title).toContain("Cooling System")
  })
})
