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
    // Every host that runs the sidecar can ask a client to execute a
    // renderer-owned tool, so the desktop advertises it too. Only the three
    // round-trips whose answer is remotely reachable are named: adding
    // `plugin_hook_exec` here would tell a client to run a hook whose response
    // command still 404s.
    expect(manifest.features["claude.controller-tool-proxy"]).toEqual({
      version: 1,
      operations: ["plugin_tool_exec", "tool_result_review", "protocol_adapter_exec"],
    })
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

describe("external-agent.host-configs", () => {
  // The feature is what tells a browser this host can BE the authority for an
  // external agent. A client that cannot see it must not offer remote external
  // agents at all, so an unadvertised feature is a silently disabled surface.
  it.each(["tauri", "headless"] as const)("is advertised on %s, which can spawn", (platform) => {
    const feature = buildLocalHostFeatureManifest({ platform }).features[
      "external-agent.host-configs"
    ]
    expect(feature?.version).toBe(1)
    expect(feature?.operations).toEqual([
      "external_agent_config_list",
      "external_agent_config_get",
      "external_agent_config_create",
      "external_agent_config_update",
      "external_agent_config_delete",
      "external_agent_config_reconcile",
      "external_agent_admit_run",
      "external_agent_release_run",
      "external_agent_run_turn",
      "external_agent_cancel_run",
      "external_agent_resolve_decision",
    ])
  })

  // Admission and the run plane ride the same feature id. A host advertising
  // the store without them would look runnable to a client and refuse every
  // turn at send time — with an "unknown command" rather than a reason.
  it("advertises admission alongside the store", () => {
    const manifest = buildLocalHostFeatureManifest({ platform: "headless" })
    for (const operation of [
      "external_agent_admit_run",
      "external_agent_release_run",
      "external_agent_run_turn",
      "external_agent_cancel_run",
      "external_agent_resolve_decision",
    ]) {
      expect(supportsHostFeatureOperation(manifest, "external-agent.host-configs", operation)).toBe(
        true
      )
    }
  })

  // A thin client hosts no process, so it can hold no configuration authority.
  it.each(["web", "mobile"] as const)("is absent on %s, which cannot spawn", (platform) => {
    expect(
      buildLocalHostFeatureManifest({ platform }).features["external-agent.host-configs"]
    ).toBeUndefined()
  })

  // Per-operation rather than per-feature: a host that ships the store but not
  // yet the reconcile command has to be describable.
  it("answers per operation, not per feature", () => {
    const manifest = buildLocalHostFeatureManifest({ platform: "tauri" })
    expect(
      supportsHostFeatureOperation(
        manifest,
        "external-agent.host-configs",
        "external_agent_config_create"
      )
    ).toBe(true)
    expect(
      supportsHostFeatureOperation(
        manifest,
        "external-agent.host-configs",
        "external_agent_config_not_a_command"
      )
    ).toBe(false)
  })

  it("survives the wire — parse keeps the feature a client gates on", () => {
    const parsed = parseHostFeatureManifest(
      JSON.parse(JSON.stringify(buildLocalHostFeatureManifest({ platform: "headless" })))
    )
    expect(parsed?.features["external-agent.host-configs"]?.operations).toContain(
      "external_agent_config_list"
    )
  })
})

describe("external-agent.process-plane", () => {
  it.each(["tauri", "headless"] as const)("advertises the spawn arms on %s", (platform) => {
    expect(
      buildLocalHostFeatureManifest({ platform }).features["external-agent.process-plane"]
        ?.operations
    ).toEqual(expect.arrayContaining(["spawn_external_agent", "kill_external_agent"]))
  })

  it("advertises runtime detection only where an arm answers it", () => {
    // The desktop answers it natively. The headless brain's dispatch has no
    // case for it, so advertising it there would let a companion past the gate
    // this per-operation list exists to be, straight into an unknown command.
    expect(
      supportsHostFeatureOperation(
        buildLocalHostFeatureManifest({ platform: "tauri" }),
        "external-agent.process-plane",
        "external_agent_detect_runtimes"
      )
    ).toBe(true)
    expect(
      supportsHostFeatureOperation(
        buildLocalHostFeatureManifest({ platform: "headless" }),
        "external-agent.process-plane",
        "external_agent_detect_runtimes"
      )
    ).toBe(false)
  })
})

describe("hostStateScope", () => {
  it("is absent unless the Host declares one", () => {
    const manifest = buildLocalHostFeatureManifest({ platform: "headless", hostId: "host-a" })
    expect(manifest.hostStateScope).toBeUndefined()
    expect("hostStateScope" in manifest).toBe(false)
  })

  it("carries the Host's own runtime target, not the id the device paired under", () => {
    const manifest = buildLocalHostFeatureManifest({
      platform: "headless",
      hostId: "2554514ce17e9c0bf0438b053676bc2e",
      hostStateScope: { accountId: "local_acct_a", runtimeTargetId: "local-host" },
    })
    // The two ids are deliberately different: one names the pairing, the
    // other names the namespace the Host writes its channels to.
    expect(manifest.hostIdentity.id).toBe("2554514ce17e9c0bf0438b053676bc2e")
    expect(manifest.hostStateScope).toEqual({
      accountId: "local_acct_a",
      runtimeTargetId: "local-host",
    })
  })

  it("survives the wire", () => {
    const parsed = parseHostFeatureManifest(
      JSON.parse(
        JSON.stringify(
          buildLocalHostFeatureManifest({
            platform: "headless",
            hostStateScope: { accountId: "acct-1", runtimeTargetId: "local-host" },
          })
        )
      )
    )
    expect(parsed?.schemaVersion).toBe(2)
    expect(parsed?.schemaVersion === 2 ? parsed.hostStateScope : undefined).toEqual({
      accountId: "acct-1",
      runtimeTargetId: "local-host",
    })
  })

  it.each([
    ["an empty runtime target", { accountId: "acct-1", runtimeTargetId: "" }],
    ["an empty account", { accountId: "", runtimeTargetId: "local-host" }],
    ["a non-string runtime target", { accountId: "acct-1", runtimeTargetId: 7 }],
    ["a non-object scope", "local-host"],
  ])("rejects a manifest declaring %s", (_label, hostStateScope) => {
    const wire = JSON.parse(
      JSON.stringify(buildLocalHostFeatureManifest({ platform: "headless" }))
    ) as Record<string, unknown>
    wire.hostStateScope = hostStateScope
    expect(parseHostFeatureManifest(wire)).toBeNull()
  })
})

describe("workspace.task-workspace", () => {
  // The plane had no descriptor at all. Both hosts dispatched every arm, and
  // `resolveOperationAvailability` still answered `operation-unavailable`, so a
  // companion refused its own chat turn before the request left the device.
  it("is advertised by both execution hosts and by neither thin client", () => {
    for (const platform of ["tauri", "headless"] as const) {
      const manifest = buildLocalHostFeatureManifest({ platform })
      expect(manifest.features["workspace.task-workspace"]?.operations).toEqual(
        expect.arrayContaining([
          "task_workspace_bundle_acquire",
          "task_workspace_bundle_turn_begin",
          "task_workspace_bundle_turn_settle",
          "task_workspace_record_tool_event",
        ])
      )
    }
    expect(
      buildLocalHostFeatureManifest({ platform: "web" }).features["workspace.task-workspace"]
    ).toBeUndefined()
  })

  it("leaves the caller's own subscription out, because it never travels", () => {
    const operations =
      buildLocalHostFeatureManifest({ platform: "headless" }).features["workspace.task-workspace"]
        ?.operations ?? []

    expect(operations).not.toContain("task_workspace_watch")
    expect(operations).not.toContain("task_workspace_stop_watch")
  })

  // The plane is unusable without a lease, but naming the minter twice makes
  // the whole manifest unparseable: the flat operation list is a flatMap and
  // the parser rejects a duplicate name.
  it("relies on source-control.git for the lease minter rather than repeating it", () => {
    const manifest = buildLocalHostFeatureManifest({ platform: "headless" })

    expect(manifest.features["workspace.task-workspace"]?.operations).not.toContain(
      "host_admin_lease_issue"
    )
    expect(manifest.operations.map((operation) => operation.name)).toContain(
      "host_admin_lease_issue"
    )
    expect(parseHostFeatureManifest(JSON.parse(JSON.stringify(manifest)))).not.toBeNull()
  })
})
