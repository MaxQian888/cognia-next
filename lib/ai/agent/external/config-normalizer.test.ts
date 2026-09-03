import {
  SUPPORTED_EXTERNAL_AGENT_PROTOCOLS,
  isSupportedExternalAgentProtocol,
  getUnsupportedProtocolReason,
  isTransportSupportedOnCurrentPlatform,
  getExternalAgentExecutionBlockReason,
  getExternalAgentExecutionBlock,
  isExternalAgentExecutable,
  getExternalAgentEcosystemReadiness,
  probeExternalAgentEcosystemReadiness,
  projectExternalAgentReadinessMetadata,
  normalizeExternalAgentConfigInput,
} from "./config-normalizer"
import {
  registerPluginProtocolAdapter,
  unregisterPluginProtocolAdaptersByPlugin,
  __resetPluginProtocolAdaptersForTesting,
  BaseProtocolAdapter,
} from "./protocol-adapter"
import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentSession,
} from "@/types/agent/external-agent"

function baseConfig(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: "agent-1",
    name: "Test",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    process: { command: "echo", args: [], cwd: "/tmp" },
    defaultPermissionMode: "default",
    timeout: 30000,
    metadata: {
      ecosystemAdapterId: "claude-code",
      ecosystemSurfaceId: "acp-stdio",
      preset: "claude-code",
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe("SUPPORTED_EXTERNAL_AGENT_PROTOCOLS", () => {
  it("contains the seven registered built-in adapters", () => {
    expect(SUPPORTED_EXTERNAL_AGENT_PROTOCOLS).toEqual([
      "acp",
      "codex-app-server",
      "dsh-sdk",
      "pi-rpc",
      "opencode",
      "opencode-v2",
      "a2a",
    ])
  })
})

describe("isSupportedExternalAgentProtocol", () => {
  it("returns true for the built-in protocols", () => {
    expect(isSupportedExternalAgentProtocol("acp")).toBe(true)
    expect(isSupportedExternalAgentProtocol("opencode")).toBe(true)
    expect(isSupportedExternalAgentProtocol("opencode-v2")).toBe(true)
    expect(isSupportedExternalAgentProtocol("codex-app-server")).toBe(true)
    expect(isSupportedExternalAgentProtocol("a2a")).toBe(true)
    expect(isSupportedExternalAgentProtocol("dsh-sdk")).toBe(true)
    expect(isSupportedExternalAgentProtocol("pi-rpc")).toBe(true)
  })
  it("returns false for unknown protocols", () => {
    expect(isSupportedExternalAgentProtocol("custom" as never)).toBe(false)
  })
})

describe("getUnsupportedProtocolReason", () => {
  it("returns empty string for supported protocols", () => {
    expect(getUnsupportedProtocolReason("acp")).toBe("")
  })
  it("returns a migration reason for unsupported protocols", () => {
    expect(getUnsupportedProtocolReason("websocket" as never)).toMatch(/not executable yet/i)
  })
  it("returns a plugin-specific reason for a namespaced (plugin) protocol", () => {
    expect(getUnsupportedProtocolReason("acme:demo" as never)).toMatch(/plugin adapter/i)
  })
})

describe("isTransportSupportedOnCurrentPlatform", () => {
  it("returns true for non-stdio transports", () => {
    expect(isTransportSupportedOnCurrentPlatform("http")).toBe(true)
    expect(isTransportSupportedOnCurrentPlatform("websocket")).toBe(true)
  })
  it("returns true for stdio when runtimeIsTauri=true", () => {
    expect(isTransportSupportedOnCurrentPlatform("stdio", true)).toBe(true)
  })
  it("returns false for stdio when runtimeIsTauri=false", () => {
    expect(isTransportSupportedOnCurrentPlatform("stdio", false)).toBe(false)
  })
  it("uses headless-host capability when no runtime override is supplied", () => {
    ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
    try {
      expect(isTransportSupportedOnCurrentPlatform("stdio")).toBe(true)
    } finally {
      delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
    }
  })
})

describe("getExternalAgentExecutionBlock", () => {
  it("blocks disabled agents", () => {
    const block = getExternalAgentExecutionBlock(baseConfig({ enabled: false }))
    expect(block?.code).toBe("agent_disabled")
  })

  it("blocks unsupported protocols", () => {
    const block = getExternalAgentExecutionBlock(baseConfig({ protocol: "custom" as never }))
    expect(block?.code).toBe("protocol_unsupported")
  })

  it("blocks stdio transport when runtime is not Tauri", () => {
    const block = getExternalAgentExecutionBlock(baseConfig(), false)
    expect(block?.code).toBe("transport_blocked")
  })

  it("runs a stdio agent through a paired host that can start the process", () => {
    // The bug this replaced: a browser paired to a Host was told it needed the
    // desktop app, about a Host that could have spawned the child immediately.
    expect(getExternalAgentExecutionBlock(baseConfig(), { ok: true, via: "remote" })).toBeNull()
  })

  it("names the actual obstacle instead of blaming the runtime", () => {
    const cases = [
      ["not-granted", /agent control/i],
      ["manifest-missing", /has not finished/i],
      ["unsupported", /does not start/i],
      ["no-host", /desktop app, or a paired host/i],
    ] as const
    for (const [reason, matcher] of cases) {
      const block = getExternalAgentExecutionBlock(baseConfig(), { ok: false, reason })
      expect(block?.code).toBe("transport_blocked")
      expect(block?.reason).toMatch(matcher)
    }
  })

  it("marks a transport block transient for every obstacle a wait can clear", () => {
    // The verdict describes the SHELL, not the agent: a Host finishing its
    // handshake, a socket reconnecting, or an Agent Control grant arriving all
    // turn the same configuration runnable without anyone touching it. So no
    // caller may persist a decision from one.
    //
    // `manifest-missing` alone used to carry the marker, and the reason a
    // companion reports before its boot provider has run is `no-host` (the
    // runtime snapshot starts empty, and the provider effect runs after its
    // children commit). The composer chip read that as settled and rewrote the
    // user's chosen agent back to the built-in lane on every reload.
    for (const reason of ["manifest-missing", "no-host", "not-granted"] as const) {
      expect(getExternalAgentExecutionBlock(baseConfig(), { ok: false, reason })?.transient).toBe(
        true
      )
    }
  })

  it("leaves a Host that has said no as a settled verdict", () => {
    // `unsupported` is the answer of a Host that finished its handshake and
    // does not start agent processes. Waiting never clears it, and a block
    // nothing can settle leaves the chip stuck with no way back.
    expect(
      getExternalAgentExecutionBlock(baseConfig(), { ok: false, reason: "unsupported" })?.transient
    ).toBe(false)
  })

  it("returns null for a healthy executable acp config in Tauri runtime", () => {
    expect(getExternalAgentExecutionBlock(baseConfig(), true)).toBeNull()
  })

  it("does NOT block a plugin-contributed protocol while its adapter is registered", () => {
    class StubAdapter extends BaseProtocolAdapter {
      readonly protocol = "acme:demo"
      async connect() {}
      async disconnect() {}
      async createSession(): Promise<ExternalAgentSession> {
        const s = {
          id: "s",
          agentId: "a",
          status: "active",
          createdAt: new Date(),
          lastActivityAt: new Date(),
        } as ExternalAgentSession
        this._sessions.set(s.id, s)
        return s
      }
      async closeSession() {}
      async *prompt(): AsyncIterable<ExternalAgentEvent> {}
      async respondToPermission() {}
      async cancel() {}
    }
    registerPluginProtocolAdapter("acme:demo", () => new StubAdapter(), { pluginId: "acme" })
    try {
      const cfg = baseConfig({ protocol: "acme:demo" as never, metadata: {} })
      expect(getExternalAgentExecutionBlock(cfg, true)).toBeNull()
    } finally {
      unregisterPluginProtocolAdaptersByPlugin("acme")
    }
    // Once the providing plugin is disabled (adapter unregistered), it blocks.
    const cfg = baseConfig({ protocol: "acme:demo" as never, metadata: {} })
    expect(getExternalAgentExecutionBlock(cfg, true)?.code).toBe("protocol_unsupported")
    __resetPluginProtocolAdaptersForTesting()
  })

  it("blocks an auto-spawn OpenCode config off-desktop (spawn needs Tauri)", () => {
    const cfg = baseConfig({
      protocol: "opencode" as never,
      transport: "sse" as never,
      process: { command: "opencode", args: [] },
      metadata: { autoSpawnServer: true },
    })
    const block = getExternalAgentExecutionBlock(cfg, false)
    expect(block?.code).toBe("transport_blocked")
    expect(block?.reason).toMatch(/desktop/i)
    // Same config IS executable on desktop.
    expect(getExternalAgentExecutionBlock(cfg, true)).toBeNull()
  })

  it("does not block a remote OpenCode config (explicit endpoint) off-desktop", () => {
    const cfg = baseConfig({
      protocol: "opencode" as never,
      transport: "sse" as never,
      process: undefined,
      network: { endpoint: "http://127.0.0.1:4096" },
      metadata: {},
    })
    expect(getExternalAgentExecutionBlock(cfg, false)).toBeNull()
  })

  it("does not recommend launching the incompatible legacy OpenCode V2 service", () => {
    const cfg = baseConfig({
      protocol: "opencode-v2" as never,
      transport: "sse" as never,
      metadata: {},
    })
    const block = getExternalAgentExecutionBlock(cfg, false)
    expect(block?.code).toBe("transport_blocked")
    expect(block?.reason).toMatch(/documented-only/i)
    expect(block?.reason).not.toContain("opencode2 service start")
  })

  it("blocks documented-only ecosystem surfaces", () => {
    const cfg = baseConfig({
      metadata: {
        ecosystemAdapterId: "codex",
        ecosystemSurfaceId: "ide-extension",
        preset: undefined,
      },
      transport: "http",
    })
    const block = getExternalAgentExecutionBlock(cfg, true)
    expect(block?.code).toBe("ecosystem_documented_only")
  })
})

describe("getExternalAgentExecutionBlockReason / isExternalAgentExecutable", () => {
  it("returns null reason for executable config", () => {
    expect(getExternalAgentExecutionBlockReason(baseConfig(), true)).toBeNull()
    expect(isExternalAgentExecutable(baseConfig(), true)).toBe(true)
  })
  it("returns the block reason for blocked config", () => {
    expect(getExternalAgentExecutionBlockReason(baseConfig({ enabled: false }))).toMatch(
      /disabled/i
    )
    expect(isExternalAgentExecutable(baseConfig({ enabled: false }))).toBe(false)
  })
})

describe("getExternalAgentEcosystemReadiness", () => {
  it("returns undefined when no ecosystem markers exist", () => {
    expect(getExternalAgentEcosystemReadiness({ metadata: {}, transport: "http" })).toBeUndefined()
  })

  it("synthesizes readiness from preset metadata when storedReadiness is absent", () => {
    const out = getExternalAgentEcosystemReadiness(
      {
        metadata: { preset: "codex", ecosystemAdapterId: "codex", ecosystemSurfaceId: "acp-stdio" },
        transport: "stdio",
      },
      false
    )
    expect(out?.adapterId).toBe("codex")
    expect(out?.prerequisites?.find((p) => p.id === "desktop-runtime")?.status).toBe("missing")
    expect(out?.prerequisiteStatus).toBe("action-required")
    expect(out?.recommendedActions?.length ?? 0).toBeGreaterThan(0)
  })

  it("flips desktop prerequisite to satisfied when runtimeIsTauri=true", () => {
    const out = getExternalAgentEcosystemReadiness(
      {
        metadata: { preset: "codex", ecosystemAdapterId: "codex", ecosystemSurfaceId: "acp-stdio" },
        transport: "stdio",
      },
      true
    )
    expect(out?.prerequisites?.find((p) => p.id === "desktop-runtime")?.status).toBe("satisfied")
  })

  it("returns storedReadiness when metadata.ecosystemReadiness is provided", () => {
    const stored = {
      prerequisiteStatus: "ready",
      prerequisites: [{ id: "x", label: "x", status: "satisfied" }],
      recommendedActions: ["a"],
    }
    const out = getExternalAgentEcosystemReadiness({
      metadata: {
        ecosystemAdapterId: "codex",
        ecosystemSurfaceId: "acp-stdio",
        ecosystemReadiness: stored,
      },
      transport: "stdio",
    })
    expect(out?.prerequisiteStatus).toBe("ready")
    expect(out?.recommendedActions).toEqual(["a"])
  })

  it("derives readiness from documented-only metadata only", () => {
    const out = getExternalAgentEcosystemReadiness(
      {
        metadata: {
          ecosystemAdapterId: "codex",
          ecosystemSurfaceId: "ide-extension",
        },
        transport: "http",
      },
      true
    )
    expect(out?.supportTier).toBe("documented-only")
    expect(out?.prerequisiteStatus).toBe("not-applicable")
  })
})

describe("probeExternalAgentEcosystemReadiness", () => {
  it("appends a 'local-command' prerequisite based on checkCommandExists=true", async () => {
    const out = await probeExternalAgentEcosystemReadiness(
      {
        metadata: { preset: "codex", ecosystemAdapterId: "codex", ecosystemSurfaceId: "acp-stdio" },
        transport: "stdio",
        process: { command: "fake", args: [] },
      },
      {
        runtimeIsTauri: true,
        checkCommandExists: async () => true,
        platform: "linux",
      }
    )
    expect(out?.prerequisites?.find((p) => p.id === "local-command")?.status).toBe("satisfied")
  })

  it("appends a missing 'local-command' prerequisite and recommendation when not on PATH", async () => {
    const out = await probeExternalAgentEcosystemReadiness(
      {
        metadata: { preset: "codex", ecosystemAdapterId: "codex", ecosystemSurfaceId: "acp-stdio" },
        transport: "stdio",
        process: { command: "fake", args: [] },
      },
      {
        runtimeIsTauri: true,
        checkCommandExists: async () => false,
      }
    )
    expect(out?.prerequisites?.find((p) => p.id === "local-command")?.status).toBe("missing")
    // The command name rides in `params` now — the sentence itself lives in
    // the message catalogue, so it is no longer asserted here as English.
    expect(out?.recommendedActions).toEqual(
      expect.arrayContaining([{ id: "installCommand", params: { command: "fake" } }])
    )
  })

  it("names the install command for a known agent CLI", async () => {
    const out = await probeExternalAgentEcosystemReadiness(
      {
        metadata: { preset: "codex-app-server" },
        transport: "stdio",
        process: { command: "codex", args: ["app-server"] },
      },
      { runtimeIsTauri: true, checkCommandExists: async () => false }
    )
    expect(out?.recommendedActions).toEqual(expect.arrayContaining([{ id: "installHintCodex" }]))
  })

  it("probes the command for a hand-written stdio config with no ecosystem identity", async () => {
    const out = await probeExternalAgentEcosystemReadiness(
      {
        metadata: {},
        transport: "stdio",
        process: { command: "codex", args: ["app-server"] },
      },
      { runtimeIsTauri: true, checkCommandExists: async () => false }
    )
    // Without this the missing binary slipped past the execution gate and only
    // surfaced as a raw spawn "os error 2".
    expect(out?.prerequisites?.find((p) => p.id === "local-command")?.status).toBe("missing")
    expect(out?.prerequisiteStatus).toBe("action-required")
  })

  it("replaces a stale 'local-command' prerequisite instead of appending a second one", async () => {
    const stale = await probeExternalAgentEcosystemReadiness(
      {
        metadata: { preset: "codex-app-server" },
        transport: "stdio",
        process: { command: "codex", args: [] },
      },
      { runtimeIsTauri: true, checkCommandExists: async () => true }
    )
    expect(stale?.prerequisites?.find((p) => p.id === "local-command")?.status).toBe("satisfied")

    // Re-probe after the CLI was uninstalled, against the persisted snapshot.
    const out = await probeExternalAgentEcosystemReadiness(
      {
        metadata: projectExternalAgentReadinessMetadata({ preset: "codex-app-server" }, stale!),
        transport: "stdio",
        process: { command: "codex", args: [] },
      },
      { runtimeIsTauri: true, checkCommandExists: async () => false }
    )
    const entries = out?.prerequisites?.filter((p) => p.id === "local-command") ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0]?.status).toBe("missing")
  })

  it("blocks connect for a hand-written stdio config whose command is missing", async () => {
    const probed = await probeExternalAgentEcosystemReadiness(
      { metadata: {}, transport: "stdio", process: { command: "codex", args: [] } },
      { runtimeIsTauri: true, checkCommandExists: async () => false }
    )
    const config = baseConfig({
      transport: "stdio",
      process: { command: "codex", args: [] },
      metadata: projectExternalAgentReadinessMetadata({}, probed!),
    })
    const block = getExternalAgentExecutionBlock(config, true)
    expect(block?.code).toBe("ecosystem_prerequisite_missing")
    expect(block?.reason).toMatch(/codex/)
  })

  it("adds a Windows-specific recommendation for the codex acp-stdio surface", async () => {
    const out = await probeExternalAgentEcosystemReadiness(
      {
        metadata: { preset: "codex", ecosystemAdapterId: "codex", ecosystemSurfaceId: "acp-stdio" },
        transport: "stdio",
        process: { command: "ok", args: [] },
      },
      {
        runtimeIsTauri: true,
        checkCommandExists: async () => true,
        platform: "win32",
      }
    )
    expect(out?.recommendedActions).toEqual(expect.arrayContaining([{ id: "codexWsl2" }]))
  })

  it("returns undefined when readiness cannot be derived", async () => {
    expect(
      await probeExternalAgentEcosystemReadiness({ metadata: {}, transport: "http" })
    ).toBeUndefined()
  })

  it("returns base readiness when checkCommandExists is omitted", async () => {
    const out = await probeExternalAgentEcosystemReadiness(
      {
        metadata: { preset: "codex", ecosystemAdapterId: "codex", ecosystemSurfaceId: "acp-stdio" },
        transport: "stdio",
        process: { command: "ok", args: [] },
      },
      { runtimeIsTauri: true }
    )
    expect(out?.prerequisites?.find((p) => p.id === "local-command")).toBeUndefined()
  })
})

describe("projectExternalAgentReadinessMetadata", () => {
  it("merges readiness fields onto the metadata payload", () => {
    const md = projectExternalAgentReadinessMetadata(
      { existing: "field" },
      {
        adapterId: "codex",
        adapterName: "Codex",
        surfaceId: "acp-stdio",
        surfaceName: "Codex CLI",
        supportTier: "executable",
        executionMode: "direct",
        docsUrl: "https://example",
        prerequisiteStatus: "ready",
        prerequisites: [],
        recommendedActions: [],
      }
    )
    expect(md.existing).toBe("field")
    expect(md.ecosystemAdapterId).toBe("codex")
    expect(md.ecosystemSupportTier).toBe("executable")
  })
})

describe("normalizeExternalAgentConfigInput", () => {
  it("creates a config with sane defaults from a minimal input", () => {
    const cfg = normalizeExternalAgentConfigInput({
      name: "  Test  ",
      protocol: "acp",
      transport: "stdio",
      process: { command: "echo", args: [] },
    } as never)
    expect(cfg.name).toBe("Test")
    expect(cfg.timeout).toBe(300000)
    expect(cfg.retryConfig?.maxRetries).toBe(3)
    expect(cfg.metadata).toBeDefined()
    expect(cfg.id).toBeTruthy()
    expect(cfg.validitySnapshot).toBeDefined()
    expect(cfg.enabled).toBe(true)
  })

  it("clamps the default permission mode to one the protocol can enforce", () => {
    // Codex has no `dontAsk` — persisting it would store a backend-incompatible
    // mode, so it is clamped down to the nearest supported mode (`plan`).
    const codex = normalizeExternalAgentConfigInput(
      {
        name: "Codex",
        protocol: "codex-app-server",
        transport: "stdio",
        defaultPermissionMode: "dontAsk",
      } as never,
      { runtimeIsTauri: true }
    )
    expect(codex.defaultPermissionMode).toBe("plan")

    // ACP supports every mode, so it round-trips unchanged.
    const acp = normalizeExternalAgentConfigInput(
      {
        name: "Claude",
        protocol: "acp",
        transport: "stdio",
        defaultPermissionMode: "dontAsk",
      } as never,
      { runtimeIsTauri: true }
    )
    expect(acp.defaultPermissionMode).toBe("dontAsk")
  })

  it("passes codexOptions through to the normalized config", () => {
    const cfg = normalizeExternalAgentConfigInput(
      {
        name: "Codex",
        protocol: "codex-app-server",
        transport: "stdio",
        codexOptions: {
          sandboxMode: "workspaceWrite",
          networkAccess: true,
          defaultReasoningEffort: "high",
          reasoningSummary: "detailed",
        },
      } as never,
      { runtimeIsTauri: true }
    )
    expect(cfg.codexOptions).toEqual({
      sandboxMode: "workspaceWrite",
      networkAccess: true,
      defaultReasoningEffort: "high",
      reasoningSummary: "detailed",
    })
  })

  it("flags an unsupported protocol in metadata", () => {
    const cfg = normalizeExternalAgentConfigInput(
      {
        name: "Old",
        protocol: "websocket" as never,
        transport: "websocket",
      } as never,
      { runtimeIsTauri: true }
    )
    expect(cfg.metadata?.unsupported).toBe(true)
    expect(cfg.metadata?.unsupportedProtocol).toBe("websocket")
  })

  it("does NOT flag the built-in codex-app-server / a2a protocols as unsupported", () => {
    for (const protocol of ["codex-app-server", "a2a"] as const) {
      const cfg = normalizeExternalAgentConfigInput(
        { name: protocol, protocol, transport: protocol === "a2a" ? "http" : "stdio" } as never,
        { runtimeIsTauri: true }
      )
      expect(cfg.metadata?.unsupported).toBeUndefined()
    }
  })

  it("removes prior unsupported markers when a supported protocol is set", () => {
    const cfg = normalizeExternalAgentConfigInput(
      {
        name: "OK",
        protocol: "acp",
        transport: "http",
        metadata: { unsupported: true, unsupportedProtocol: "x", unsupportedReason: "y" },
      } as never,
      { runtimeIsTauri: true }
    )
    expect(cfg.metadata?.unsupported).toBeUndefined()
    expect(cfg.metadata?.unsupportedProtocol).toBeUndefined()
    expect(cfg.metadata?.unsupportedReason).toBeUndefined()
  })

  it("respects supplied id, enabled, and retryConfig overrides", () => {
    const cfg = normalizeExternalAgentConfigInput(
      {
        name: "X",
        protocol: "acp",
        transport: "http",
        retryConfig: {
          maxRetries: 7,
          retryDelay: 500,
          exponentialBackoff: false,
          maxRetryDelay: 5000,
          retryOnErrors: ["timeout"],
        },
      } as never,
      { id: "custom", enabled: false, runtimeIsTauri: true }
    )
    expect(cfg.id).toBe("custom")
    expect(cfg.enabled).toBe(false)
    expect(cfg.retryConfig?.maxRetries).toBe(7)
    expect(cfg.retryConfig?.exponentialBackoff).toBe(false)
  })

  it("captures the block reason in the validity snapshot when blocked", () => {
    const cfg = normalizeExternalAgentConfigInput(
      {
        name: "Blocked",
        protocol: "acp",
        transport: "stdio",
        process: { command: "fake", args: [] },
      } as never,
      { runtimeIsTauri: false }
    )
    expect(cfg.validitySnapshot?.executable).toBe(false)
    expect(cfg.validitySnapshot?.blockingReasonCode).toBe("transport_blocked")
  })
})

describe("recommended actions — persisted shape", () => {
  it("keeps prose an older build (or a third-party preset) persisted", async () => {
    const out = await probeExternalAgentEcosystemReadiness(
      {
        metadata: {
          preset: "codex-app-server",
          ecosystemReadiness: { recommendedActions: ["Read the vendor runbook first."] },
        },
        transport: "stdio",
        process: { command: "codex", args: ["app-server"] },
      },
      { runtimeIsTauri: true, checkCommandExists: async () => true }
    )
    expect(out?.recommendedActions).toContain("Read the vendor runbook first.")
  })

  it("drops persisted entries that are neither prose nor a message reference", async () => {
    // This array round-trips through config metadata, so it is untrusted:
    // an unchecked value reaches the renderer and prints [object Object].
    const out = await probeExternalAgentEcosystemReadiness(
      {
        metadata: {
          preset: "codex-app-server",
          ecosystemReadiness: {
            recommendedActions: [42, null, { params: { a: "b" } }, ["nested"], { id: "  " }, "  "],
          },
        },
        transport: "stdio",
        process: { command: "codex", args: ["app-server"] },
      },
      { runtimeIsTauri: true, checkCommandExists: async () => true }
    )
    expect(out?.recommendedActions ?? []).toEqual([])
  })

  it("keeps non-string params out of a message reference", async () => {
    const out = await probeExternalAgentEcosystemReadiness(
      {
        metadata: {
          preset: "codex-app-server",
          ecosystemReadiness: {
            recommendedActions: [{ id: "installCommand", params: { command: "x", bad: 7 } }],
          },
        },
        transport: "stdio",
        process: { command: "codex", args: ["app-server"] },
      },
      { runtimeIsTauri: true, checkCommandExists: async () => true }
    )
    expect(out?.recommendedActions).toEqual([{ id: "installCommand", params: { command: "x" } }])
  })

  it("does not collapse two message references that differ only in params", async () => {
    const out = await probeExternalAgentEcosystemReadiness(
      {
        metadata: {
          preset: "codex-app-server",
          ecosystemReadiness: {
            recommendedActions: [
              { id: "installCommand", params: { command: "a" } },
              { id: "installCommand", params: { command: "b" } },
              { id: "installCommand", params: { command: "a" } },
            ],
          },
        },
        transport: "stdio",
        process: { command: "codex", args: ["app-server"] },
      },
      { runtimeIsTauri: true, checkCommandExists: async () => true }
    )
    expect(out?.recommendedActions).toEqual([
      { id: "installCommand", params: { command: "a" } },
      { id: "installCommand", params: { command: "b" } },
    ])
  })
})
