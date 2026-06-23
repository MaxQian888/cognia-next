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
  it("contains the four registered built-in adapters", () => {
    expect(SUPPORTED_EXTERNAL_AGENT_PROTOCOLS).toEqual([
      "acp",
      "codex-app-server",
      "opencode",
      "a2a",
    ])
  })
})

describe("isSupportedExternalAgentProtocol", () => {
  it("returns true for the four built-in protocols", () => {
    expect(isSupportedExternalAgentProtocol("acp")).toBe(true)
    expect(isSupportedExternalAgentProtocol("opencode")).toBe(true)
    expect(isSupportedExternalAgentProtocol("codex-app-server")).toBe(true)
    expect(isSupportedExternalAgentProtocol("a2a")).toBe(true)
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
    expect(out?.recommendedActions).toEqual(
      expect.arrayContaining([expect.stringMatching(/Install or expose "fake"/)])
    )
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
    expect(out?.recommendedActions).toEqual(
      expect.arrayContaining([expect.stringMatching(/WSL2/i)])
    )
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
