import { auditPluginRuntimeClaims } from "./runtime-proof-audit"

describe("plugin runtime proof audit", () => {
  it("reports supported capabilities with executable proof metadata", () => {
    const report = auditPluginRuntimeClaims()
    const toolsCapability = report.capabilities.find((entry) => entry.id === "tools")

    expect(toolsCapability).toEqual(
      expect.objectContaining({
        id: "tools",
        support: "supported",
        proofStatus: "verified",
        missingFields: [],
      })
    )
  })

  it("requires docs and tests for implemented plugin points", () => {
    const report = auditPluginRuntimeClaims()
    const chatHeaderPoint = report.points.find((entry) => entry.id === "chat.header")

    expect(chatHeaderPoint).toEqual(
      expect.objectContaining({
        id: "chat.header",
        kind: "ui-slot",
        status: "implemented",
        proofStatus: "verified",
      })
    )
    expect(chatHeaderPoint?.docs).toContain("docs/features/plugin-development.md")
    expect(chatHeaderPoint?.requiredTests.length).toBeGreaterThan(0)
  })

  it("flags known optimistic runtime paths that still lack executable proof", () => {
    const report = auditPluginRuntimeClaims()

    expect(report.runtimeRisks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "plugin-store.status-projection-fallback",
          proofStatus: "missing_proof",
        }),
        expect.objectContaining({
          id: "plugin-marketplace.fallback-mock",
          proofStatus: "missing_proof",
        }),
      ])
    )
  })
})
