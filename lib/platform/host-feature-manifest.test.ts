import {
  HOST_FEATURE_MANIFEST_SCHEMA_VERSION,
  buildLocalHostFeatureManifest,
  parseHostFeatureManifest,
  supportsHostFeatureOperation,
  type HostFeatureManifest,
} from "./host-feature-manifest"

describe("host feature manifest", () => {
  it("advertises the versioned Twin draft review operation on execution hosts", () => {
    const manifest = buildLocalHostFeatureManifest({ platform: "tauri" })

    expect(supportsHostFeatureOperation(manifest, "twin.runtime", "twin_draft_review")).toBe(true)
  })

  it("advertises every remotely executable Git operation with independent health", () => {
    const manifest = buildLocalHostFeatureManifest({
      platform: "tauri",
      deviceGrants: ["workspace.read", "git.write"],
      operationHealth: {
        git_push: { healthy: false, reason: "credentials unavailable" },
      },
    })

    const operations = manifest.features["source-control.git"]?.operations ?? []
    expect(operations).toEqual(expect.arrayContaining(["git_status", "git_push", "git_clone"]))
    expect(operations).not.toContain("git_watch_start")
    expect(operations).not.toContain("git_watch_stop")
    expect(operations).toContain("host_admin_lease_issue")
    expect(supportsHostFeatureOperation(manifest, "source-control.git", "git_status")).toBe(true)
    expect(supportsHostFeatureOperation(manifest, "source-control.git", "git_push")).toBe(false)
    expect(manifest.operations.find((operation) => operation.name === "git_push")).toMatchObject({
      healthy: false,
      reason: "credentials unavailable",
    })
  })

  it("does not advertise Source Control from a headless host without a workspace registrar", () => {
    const manifest = buildLocalHostFeatureManifest({ platform: "headless" })

    expect(manifest.features["source-control.git"]).toBeUndefined()
  })

  it("reports the protocol limits that remote clients must obey", () => {
    const manifest = buildLocalHostFeatureManifest({
      hostBuildId: "1.2.3",
      platform: "headless",
      hostId: "cloud-a",
      deviceGrants: ["workspace.read"],
    })

    expect(manifest).toMatchObject({
      schemaVersion: HOST_FEATURE_MANIFEST_SCHEMA_VERSION,
      hostBuildId: "1.2.3",
      platform: "headless",
      hostIdentity: { id: "cloud-a", kind: "cloud" },
      protocol: { min: 1, max: 2 },
      transportCapabilities: { eventStreamReady: 1 },
      deviceGrants: ["workspace.read"],
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
    expect(manifest.operations.every((operation) => operation.healthy)).toBe(true)
  })

  it("publishes the complete headless secret, browser, OCR, notification and file contracts", () => {
    const manifest = buildLocalHostFeatureManifest({
      platform: "headless",
      operationHealth: {
        browser_capability: { healthy: false, reason: "workspace probe failed" },
        ocr_extract_native: false,
      },
    })

    expect(manifest.features["automation.hitl"]).toBeUndefined()
    expect(manifest.features["secrets.store"]?.operations).toEqual([
      "secret_store_get",
      "secret_store_set",
      "secret_store_delete",
    ])
    expect(manifest.features["browser.remote"]?.operations).toContain("browser_runtime_status")
    expect(manifest.features["browser.remote"]?.operations).toContain("browser_set_files")
    expect(manifest.features["ocr.server"]?.operations).toContain("ocr_extract_native")
    expect(manifest.features["notifications.remote"]?.operations).not.toContain(
      "event:automation:consent-request"
    )
    expect(manifest.features["workspace.files"]?.operations).toContain("fs_write_workspace_file")
    expect(
      manifest.operations.find((operation) => operation.name === "browser_capability")
    ).toMatchObject({ healthy: false, reason: "workspace probe failed" })
    expect(supportsHostFeatureOperation(manifest, "browser.remote", "browser_capability")).toBe(
      false
    )
    expect(supportsHostFeatureOperation(manifest, "browser.remote", "browser_runtime_status")).toBe(
      true
    )
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
        operations: valid.operations.slice(1),
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
    expect(
      parseHostFeatureManifest({
        ...valid,
        operations: [
          ...valid.operations,
          {
            name: "undeclared_operation",
            feature: "skills.catalog",
            featureVersion: 1,
            healthy: true,
          },
        ],
      })
    ).toBeNull()
  })

  it("continues to parse v1 hosts and negotiates per operation without build-id equality", () => {
    const v1: HostFeatureManifest = {
      schemaVersion: 1,
      hostBuildId: "old-host-build",
      platform: "tauri",
      generatedAt: 1,
      features: {
        "skills.catalog": { version: 1, operations: ["skills_catalog_get"] },
      },
      limits: buildLocalHostFeatureManifest({ platform: "tauri" }).limits,
    }

    expect(parseHostFeatureManifest(v1)).toEqual(v1)
    expect(supportsHostFeatureOperation(v1, "skills.catalog", "skills_catalog_get")).toBe(true)
  })

  it("parses structurally valid protocol ranges instead of requiring one exact range", () => {
    const valid = buildLocalHostFeatureManifest({ platform: "headless" })

    expect(
      parseHostFeatureManifest({
        ...valid,
        protocol: { min: 2, max: 3 },
      })
    ).toMatchObject({ protocol: { min: 2, max: 3 } })
    expect(
      parseHostFeatureManifest({
        ...valid,
        protocol: { min: 3, max: 2 },
      })
    ).toBeNull()
  })

  it("rejects malformed event-stream readiness capability versions", () => {
    const valid = buildLocalHostFeatureManifest({ platform: "headless" })

    expect(
      parseHostFeatureManifest({
        ...valid,
        transportCapabilities: { eventStreamReady: 2 },
      })
    ).toBeNull()
    expect(
      parseHostFeatureManifest({
        ...valid,
        transportCapabilities: { eventStreamReady: 1 },
      })
    ).toMatchObject({ transportCapabilities: { eventStreamReady: 1 } })
  })

  it("fails operation support closed for an unsupported feature version", () => {
    const manifest = buildLocalHostFeatureManifest({ platform: "headless" })
    manifest.features["skills.catalog"] = {
      version: 2,
      operations: ["skills_catalog_get"],
    }
    manifest.operations = manifest.operations
      .filter((operation) => operation.feature !== "skills.catalog")
      .concat({
        name: "skills_catalog_get",
        feature: "skills.catalog",
        featureVersion: 2,
        healthy: true,
      })

    expect(parseHostFeatureManifest(manifest)).toEqual(manifest)
    expect(supportsHostFeatureOperation(manifest, "skills.catalog", "skills_catalog_get")).toBe(
      false
    )
  })
})
