import { createPluginVerificationSnapshot, collectCapabilityRuntimeProofs } from "./verification"

describe("plugin verification snapshot", () => {
  it("creates a canonical success snapshot", () => {
    const snapshot = createPluginVerificationSnapshot({
      pluginId: "demo-plugin",
      source: "marketplace",
      status: "enabled",
      verificationStage: "activation",
      lastVerifiedAction: "enable",
      resolvedVersion: "1.2.3",
      diagnostics: [
        {
          code: "plugin.lifecycle.enabled",
          severity: "warning",
          message: "Plugin enabled with warning diagnostics.",
        },
      ],
      verifiedAt: "2026-03-16T00:00:00.000Z",
      successful: true,
    })

    expect(snapshot).toEqual(
      expect.objectContaining({
        pluginId: "demo-plugin",
        source: "marketplace",
        status: "enabled",
        verificationStage: "activation",
        lastVerifiedAction: "enable",
        resolvedVersion: "1.2.3",
        lastVerifiedAt: "2026-03-16T00:00:00.000Z",
        lastSuccessfulAt: "2026-03-16T00:00:00.000Z",
      })
    )
    expect(snapshot.lastFailureAt).toBeUndefined()
  })

  it("records failure metadata without dropping the last success timestamp", () => {
    const snapshot = createPluginVerificationSnapshot({
      pluginId: "demo-plugin",
      source: "dev",
      status: "error",
      verificationStage: "reload",
      lastVerifiedAction: "reload",
      diagnostics: [
        {
          code: "plugin.reload.failed",
          severity: "error",
          message: "Reload failed.",
        },
      ],
      verifiedAt: "2026-03-16T01:00:00.000Z",
      lastSuccessfulAt: "2026-03-16T00:00:00.000Z",
      successful: false,
    })

    expect(snapshot.lastVerifiedAt).toBe("2026-03-16T01:00:00.000Z")
    expect(snapshot.lastFailureAt).toBe("2026-03-16T01:00:00.000Z")
    expect(snapshot.lastSuccessfulAt).toBe("2026-03-16T00:00:00.000Z")
  })

  it("collects executable runtime proofs for completed media, canvas, and ai-provider capabilities", () => {
    expect(collectCapabilityRuntimeProofs(["media", "canvas", "ai-provider"])).toEqual({
      media: {
        support: "supported",
        requiredTests: ["lib/plugin/api/media-api.test.ts"],
      },
      canvas: {
        support: "supported",
        requiredTests: ["lib/plugin/api/canvas-api.test.ts"],
      },
      "ai-provider": {
        support: "supported",
        requiredTests: ["lib/plugin/api/ai-provider-api.test.ts"],
      },
    })
  })

  it("embeds runtime proof metadata into verification snapshots for completed SDK capabilities", () => {
    const snapshot = createPluginVerificationSnapshot({
      pluginId: "proof-plugin",
      source: "local",
      status: "enabled",
      verificationStage: "runtime_execution",
      lastVerifiedAction: "enable",
      verifiedAt: "2026-03-16T02:00:00.000Z",
      successful: true,
      declaredCapabilities: ["media", "canvas", "ai-provider"],
    })

    expect(snapshot.metadata).toEqual(
      expect.objectContaining({
        capabilityProofs: {
          media: {
            support: "supported",
            requiredTests: ["lib/plugin/api/media-api.test.ts"],
          },
          canvas: {
            support: "supported",
            requiredTests: ["lib/plugin/api/canvas-api.test.ts"],
          },
          "ai-provider": {
            support: "supported",
            requiredTests: ["lib/plugin/api/ai-provider-api.test.ts"],
          },
        },
      })
    )
  })
})
