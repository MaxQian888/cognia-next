import {
  HOST_FEATURE_MANIFEST_SCHEMA_VERSION,
  buildLocalHostFeatureManifest,
  parseHostFeatureManifest,
  supportsHostFeatureOperation,
  type HostFeatureManifest,
} from "./host-feature-manifest"

describe("host feature manifest", () => {
  it("reports the protocol limits that remote clients must obey", () => {
    const manifest = buildLocalHostFeatureManifest({
      hostBuildId: "1.2.3",
      platform: "headless",
    })

    expect(manifest).toMatchObject({
      schemaVersion: HOST_FEATURE_MANIFEST_SCHEMA_VERSION,
      hostBuildId: "1.2.3",
      platform: "headless",
      limits: {
        rpcJsonBodyBytes: 64 * 1024,
        skillMaxResources: 50,
        skillMaxResourceBytes: 2 * 1024 * 1024,
        skillUploadChunkBytes: 32 * 1024,
        mcpRequestBodyBytes: 1024 * 1024,
      },
    })
  })

  it("advertises only operations backed by the current host implementation", () => {
    const manifest = buildLocalHostFeatureManifest({
      hostBuildId: "1.2.3",
      platform: "tauri",
    })

    expect(manifest.features["claude.host-tools"]).toEqual({
      version: 1,
      operations: expect.arrayContaining(["claude_send", "claude_interrupt"]),
    })
    expect(manifest.features["skills.catalog"]).toEqual({
      version: 1,
      operations: ["skills_catalog_get", "skills_load_registry", "skills_scan_native"],
    })
    expect(manifest.features["skills.atomic-install"]).toBeUndefined()
    expect(manifest.features["claude.controller-tool-proxy"]).toBeUndefined()
    expect(manifest.features["external-bridge.lifecycle"]).toBeUndefined()
    expect(manifest.features["external-bridge.managed-relay"]).toBeUndefined()
    expect(manifest.features["external-bridge.direct-tls"]).toBeUndefined()
  })

  it("checks both the feature and operation instead of trusting a coarse capability", () => {
    const manifest: HostFeatureManifest = {
      schemaVersion: 1,
      hostBuildId: "1.2.3",
      platform: "headless",
      generatedAt: 1,
      features: {
        "skills.catalog": { version: 1, operations: ["skills_scan_native"] },
      },
      limits: {
        rpcJsonBodyBytes: 64 * 1024,
        skillMaxResources: 50,
        skillMaxResourceBytes: 2 * 1024 * 1024,
        skillUploadChunkBytes: 32 * 1024,
        mcpRequestBodyBytes: 1024 * 1024,
        maxConcurrentProxyCalls: 32,
      },
    }

    expect(supportsHostFeatureOperation(manifest, "skills.catalog", "skills_scan_native")).toBe(
      true
    )
    expect(supportsHostFeatureOperation(manifest, "skills.catalog", "skills_install_native")).toBe(
      false
    )
    expect(supportsHostFeatureOperation(manifest, "skills.atomic-install")).toBe(false)
    expect(supportsHostFeatureOperation(null, "skills.catalog")).toBe(false)
  })

  it("rejects malformed platform, version and operation descriptors", () => {
    const valid = buildLocalHostFeatureManifest({
      hostBuildId: "1.2.3",
      platform: "headless",
    })

    expect(parseHostFeatureManifest(valid)).toEqual(valid)
    expect(parseHostFeatureManifest({ ...valid, platform: "unknown" })).toBeNull()
    expect(parseHostFeatureManifest({ ...valid, generatedAt: Number.NaN })).toBeNull()
    expect(
      parseHostFeatureManifest({
        ...valid,
        features: {
          "skills.catalog": {
            version: 0,
            operations: ["skills_catalog_get"],
          },
        },
      })
    ).toBeNull()
    expect(
      parseHostFeatureManifest({
        ...valid,
        features: {
          "skills.catalog": {
            version: 1,
            operations: ["skills_catalog_get", "skills_catalog_get"],
          },
        },
      })
    ).toBeNull()
  })
})
