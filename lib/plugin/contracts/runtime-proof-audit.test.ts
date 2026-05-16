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

  it("verifies the native-anthropic-tool capability proof is fully wired", () => {
    const report = auditPluginRuntimeClaims()
    const nativeTool = report.capabilities.find((entry) => entry.id === "native-anthropic-tool")

    expect(nativeTool).toEqual(
      expect.objectContaining({
        id: "native-anthropic-tool",
        support: "supported",
        proofStatus: "verified",
        missingFields: [],
      })
    )
    // Lock the host-binding surface so future renames are caught.
    expect(nativeTool?.hostBindings).toEqual(
      expect.arrayContaining([
        "lib/plugin/registries/native-anthropic-tool-registry.ts",
        "lib/claude/build-options.ts",
        "sidecar/dispatch/anthropic.mjs",
      ])
    )
    expect(nativeTool?.typescriptSdk).toEqual(
      expect.arrayContaining(["plugin-sdk/typescript/src/api/native-anthropic-tool.ts"])
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
