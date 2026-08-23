import {
  HOST_FEATURE_MANIFEST_SCHEMA_VERSION,
  INBOX_RELAY_HOST_OPERATIONS,
  buildLocalHostFeatureManifest,
  parseHostFeatureManifest,
  supportsHostFeatureOperation,
  type HostFeatureManifest,
} from "./host-feature-manifest"
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  COMPOSER_MAX_ATTACHMENTS,
  COMPOSER_MAX_ATTACHMENT_BYTES,
} from "@/lib/chat/attachments/prepare"

describe("host feature manifest", () => {
  it("advertises HostState v1 through the existing manifest on execution hosts", () => {
    const manifest = buildLocalHostFeatureManifest({ platform: "tauri" })

    expect(manifest.features["session.remote-control"]).toEqual({
      version: 1,
      operations: ["session_attach", "session_detach"],
    })
    expect(manifest.features["session.state-sync"]).toEqual({
      version: 1,
      operations: ["host_state_snapshot", "host_state_submit", "host_state_status"],
    })
    expect(manifest.limits).toMatchObject({
      maxHostStateSnapshotBytes: 512 * 1024,
      maxHostStateActionBatch: 50,
      maxPendingHostStateActions: 1000,
      hostStateReplayRetentionMs: 24 * 60 * 60 * 1000,
    })
    expect(supportsHostFeatureOperation(manifest, "session.state-sync", "host_state_submit")).toBe(
      true
    )
  })

  it("does not advertise HostState from non-authoritative web or mobile clients", () => {
    for (const platform of ["web", "mobile"] as const) {
      const features = buildLocalHostFeatureManifest({ platform }).features
      expect(features["session.state-sync"]).toBeUndefined()
      // Same reason: a thin client hosts no sessions, so it has no attachments
      // to lease and nothing to route a decision to.
      expect(features["session.remote-control"]).toBeUndefined()
    }
  })

  it("advertises attachment upload, with the ceilings the desktop composer enforces", () => {
    for (const platform of ["tauri", "headless"] as const) {
      const manifest = buildLocalHostFeatureManifest({ platform })
      expect(manifest.features["session.attachment-upload"]).toEqual({
        version: 1,
        operations: [
          "session_attachment_upload_init",
          "session_attachment_upload_chunk",
          "session_attachment_upload_commit",
          "session_attachment_upload_abort",
        ],
      })
      // Chunk sizing is the init response's answer, not the manifest's — one
      // authority, and the only one that can refuse a chunk.
      const limits = manifest.limits
      expect(Math.ceil(ATTACHMENT_UPLOAD_CHUNK_BYTES / 3) * 4).toBeLessThan(limits.rpcJsonBodyBytes)
      expect(limits.attachmentMaxBytes).toBe(COMPOSER_MAX_ATTACHMENT_BYTES)
      expect(limits.attachmentMaxPerMessage).toBe(COMPOSER_MAX_ATTACHMENTS)
      // Published in `<input accept>` form so a client can hand it straight to
      // a picker rather than re-deriving the list and drifting from the Host.
      expect(limits.attachmentAcceptTypes).toContain("image/*")
      expect(limits.attachmentAcceptTypes).toContain(".pdf")
    }
  })

  it("does not advertise attachment upload on a thin client, which hosts no sessions", () => {
    for (const platform of ["web", "mobile"] as const) {
      expect(
        buildLocalHostFeatureManifest({ platform }).features["session.attachment-upload"]
      ).toBeUndefined()
    }
  })

  it("advertises the ADR-0131 inbox relay on every connector host, never on thin clients", () => {
    for (const platform of ["tauri", "headless"] as const) {
      const manifest = buildLocalHostFeatureManifest({ platform })
      expect(manifest.features["connectors.inbox-relay"]).toEqual({
        version: 1,
        operations: [...INBOX_RELAY_HOST_OPERATIONS],
      })
      for (const operation of INBOX_RELAY_HOST_OPERATIONS) {
        expect(supportsHostFeatureOperation(manifest, "connectors.inbox-relay", operation)).toBe(
          true
        )
      }
      // The relay round-trips through parse: a v2 client must accept it.
      expect(parseHostFeatureManifest(manifest)?.features["connectors.inbox-relay"]).toBeDefined()
    }
    for (const platform of ["web", "mobile"] as const) {
      expect(
        buildLocalHostFeatureManifest({ platform }).features["connectors.inbox-relay"]
      ).toBeUndefined()
    }
    // A pre-relay host manifest simply lacks the feature — the client gate is
    // `supportsHostFeatureOperation`, not a version bump.
    const legacy = buildLocalHostFeatureManifest({ platform: "tauri" })
    delete legacy.features["connectors.inbox-relay"]
    legacy.operations = legacy.operations.filter((op) => op.feature !== "connectors.inbox-relay")
    expect(supportsHostFeatureOperation(legacy, "connectors.inbox-relay")).toBe(false)
  })

  it("advertises the versioned Twin draft review operation on execution hosts", () => {
    const manifest = buildLocalHostFeatureManifest({ platform: "tauri" })

    expect(supportsHostFeatureOperation(manifest, "twin.runtime", "twin_draft_review")).toBe(true)
  })

  it("advertises exact-version workflow placement only from execution Hosts", () => {
    for (const platform of ["tauri", "headless"] as const) {
      const manifest = buildLocalHostFeatureManifest({ platform })
      expect(manifest.features["workflow.execution"]).toEqual({
        version: 1,
        operations: [
          "workflow_placement_probe",
          "workflow_handoff_create",
          "workflow_run_list",
          "workflow_cancel_run",
        ],
      })
    }
    for (const platform of ["web", "mobile"] as const) {
      expect(
        buildLocalHostFeatureManifest({ platform }).features["workflow.execution"]
      ).toBeUndefined()
    }
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

  it("advertises Source Control from a headless host — its workspaces are the policy-root directories", () => {
    const manifest = buildLocalHostFeatureManifest({
      platform: "headless",
      deviceGrants: ["workspace.read", "git.write"],
    })

    const operations = manifest.features["source-control.git"]?.operations ?? []
    expect(operations).toEqual(
      expect.arrayContaining(["git_workspace_list", "git_status", "git_clone"])
    )
    expect(operations).toContain("host_admin_lease_issue")
    expect(supportsHostFeatureOperation(manifest, "source-control.git", "git_status")).toBe(true)
    // Same operation set on both hosts: one client, one contract.
    expect(operations).toEqual(
      buildLocalHostFeatureManifest({ platform: "tauri" }).features["source-control.git"]
        ?.operations
    )
  })

  it("keeps Source Control off webview-only hosts", () => {
    expect(
      buildLocalHostFeatureManifest({ platform: "web" }).features["source-control.git"]
    ).toBeUndefined()
    expect(
      buildLocalHostFeatureManifest({ platform: "mobile" }).features["source-control.git"]
    ).toBeUndefined()
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
