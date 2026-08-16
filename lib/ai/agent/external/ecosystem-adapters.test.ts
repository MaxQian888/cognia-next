import {
  EXTERNAL_AGENT_ECOSYSTEM_ADAPTERS,
  getExternalAgentEcosystemAdapter,
  listExternalAgentEcosystemAdapters,
  findExternalAgentSurfaceByPresetId,
  findExternalAgentSurface,
  checkSurfaceExecutability,
  listAllSurfacesWithTier,
  resolveExternalAgentSurfaceFromMetadata,
} from "./ecosystem-adapters"

describe("EXTERNAL_AGENT_ECOSYSTEM_ADAPTERS", () => {
  it("registers the nine expected adapters", () => {
    expect(Object.keys(EXTERNAL_AGENT_ECOSYSTEM_ADAPTERS).sort()).toEqual([
      "claude-code",
      "codex",
      "copilot-cli",
      "cursor",
      "droid",
      "gemini-cli",
      "kiro",
      "pi",
      "qwen-code",
    ])
  })

  it("offers Pi both a native RPC surface and the legacy ACP bridge", () => {
    const surfaces = EXTERNAL_AGENT_ECOSYSTEM_ADAPTERS.pi.surfaces
    expect(surfaces.map((s) => s.presetId)).toEqual(["pi-rpc", "pi"])

    // The native surface must spawn `pi` itself. Routing it back through
    // `npx pi-acp` would silently reinstate the community bridge this ADR
    // exists to remove, and nothing downstream would notice.
    const native = surfaces.find((s) => s.presetId === "pi-rpc")!
    expect(native.protocol).toBe("pi-rpc")
    expect(native.transport).toBe("stdio")
    expect(native.process).toEqual({ command: "pi", args: ["--mode", "rpc"] })

    // The bridge stays reachable and stays ACP — migration is explicit, so
    // the old surface must keep working until the user opts out of it.
    const bridged = surfaces.find((s) => s.presetId === "pi")!
    expect(bridged.protocol).toBe("acp")
    expect(bridged.process?.args).toContain("pi-acp")
  })

  it("gives every surface a stable shape", () => {
    for (const adapter of Object.values(EXTERNAL_AGENT_ECOSYSTEM_ADAPTERS)) {
      expect(adapter.id).toBeTruthy()
      expect(adapter.name).toBeTruthy()
      expect(Array.isArray(adapter.surfaces)).toBe(true)
      expect(adapter.surfaces.length).toBeGreaterThan(0)
      for (const surface of adapter.surfaces) {
        expect(surface.id).toBeTruthy()
        expect(surface.name).toBeTruthy()
        expect([
          "acp",
          "codex-app-server",
          "pi-rpc",
          "custom",
          "http",
          "websocket",
          "opencode",
        ]).toContain(surface.protocol)
        expect(["stdio", "http", "websocket"]).toContain(surface.transport)
        expect(["executable", "guided", "documented-only"]).toContain(surface.supportTier)
      }
    }
  })
})

describe("new ACP agent surfaces", () => {
  const cases: Array<{ presetId: string; command: string; args: string[] }> = [
    // The Claude Code / Gemini / Cursor ACP entrypoints are easy to get wrong
    // (a bare `--stdio` drops Gemini into interactive mode and hangs; Claude
    // Code has no native ACP flag and must run through the Zed adapter). Lock
    // the exact launch commands so a regression can't silently break them.
    {
      presetId: "claude-code",
      command: "claude-agent-acp",
      args: [],
    },
    {
      presetId: "gemini-cli",
      command: "npx",
      args: ["-y", "@google/gemini-cli", "--acp"],
    },
    { presetId: "cursor-cli", command: "cursor-agent", args: ["acp"] },
    { presetId: "copilot-cli", command: "copilot", args: ["--acp"] },
    { presetId: "kiro", command: "kiro-cli", args: ["acp"] },
    { presetId: "qwen-code", command: "npx", args: ["-y", "@qwen-code/qwen-code", "--acp"] },
    { presetId: "pi", command: "npx", args: ["-y", "pi-acp"] },
    {
      presetId: "droid",
      command: "droid",
      args: ["exec", "--output-format", "acp"],
    },
  ]

  it.each(cases)(
    "exposes an executable ACP stdio surface for $presetId",
    ({ presetId, command, args }) => {
      const found = findExternalAgentSurfaceByPresetId(presetId)
      expect(found).not.toBeNull()
      expect(found?.surface.protocol).toBe("acp")
      expect(found?.surface.transport).toBe("stdio")
      expect(found?.surface.supportTier).toBe("executable")
      expect(found?.surface.executionMode).toBe("direct")
      expect(found?.surface.process).toEqual({ command, args })
      expect(found?.surface.docsUrl).toBeTruthy()
    }
  )

  it("marks the Pi surface as a community adapter", () => {
    const found = findExternalAgentSurfaceByPresetId("pi")
    expect(found?.surface.tags).toEqual(
      expect.arrayContaining(["community-adapter", "experimental"])
    )
    expect(found?.surface.limitationNote).toMatch(/community adapter/i)
  })
})

describe("getExternalAgentEcosystemAdapter", () => {
  it("returns the adapter when it exists", () => {
    expect(getExternalAgentEcosystemAdapter("codex")?.id).toBe("codex")
  })

  it("returns null for unknown adapter ids", () => {
    expect(getExternalAgentEcosystemAdapter("not-real")).toBeNull()
  })
})

describe("listExternalAgentEcosystemAdapters", () => {
  it("returns all registered adapters", () => {
    const list = listExternalAgentEcosystemAdapters()
    expect(list.length).toBe(Object.keys(EXTERNAL_AGENT_ECOSYSTEM_ADAPTERS).length)
    expect(list.map((a) => a.id).sort()).toEqual([
      "claude-code",
      "codex",
      "copilot-cli",
      "cursor",
      "droid",
      "gemini-cli",
      "kiro",
      "pi",
      "qwen-code",
    ])
  })
})

describe("findExternalAgentSurfaceByPresetId", () => {
  it("finds 'codex' through the codex preset", () => {
    const found = findExternalAgentSurfaceByPresetId("codex")
    expect(found?.adapter.id).toBe("codex")
    expect(found?.surface.presetId).toBe("codex")
  })

  it("finds 'cursor-cli' under the cursor adapter", () => {
    const found = findExternalAgentSurfaceByPresetId("cursor-cli")
    expect(found?.adapter.id).toBe("cursor")
    expect(found?.surface.id).toBe("acp-stdio")
  })

  it("returns null for an unknown preset id", () => {
    expect(findExternalAgentSurfaceByPresetId("does-not-exist")).toBeNull()
  })
})

describe("findExternalAgentSurface", () => {
  it("finds an existing adapter+surface pair", () => {
    const found = findExternalAgentSurface("claude-code", "acp-stdio")
    expect(found?.surface.name).toBe("Claude Code")
  })

  it("returns null when adapter is missing", () => {
    expect(findExternalAgentSurface("nope", "acp-stdio")).toBeNull()
  })

  it("returns null when surface is missing within a real adapter", () => {
    expect(findExternalAgentSurface("codex", "ghost-surface")).toBeNull()
  })
})

describe("checkSurfaceExecutability", () => {
  it("returns executable=true for an executable surface", () => {
    expect(checkSurfaceExecutability("codex", "acp-stdio")).toEqual({ executable: true })
  })

  it("returns executable=false with docs URL for documented-only surfaces", () => {
    const result = checkSurfaceExecutability("codex", "ide-extension") as {
      executable: false
      error: string
      docsUrl?: string
    }
    expect(result.executable).toBe(false)
    expect(result.error).toMatch(/not directly executable/i)
    expect(result.docsUrl).toBeTruthy()
  })

  it("returns executable=false with not-found error when surface is missing", () => {
    const result = checkSurfaceExecutability("codex", "missing") as {
      executable: false
      error: string
    }
    expect(result.executable).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })
})

describe("listAllSurfacesWithTier", () => {
  it("flattens every adapter's surfaces with metadata", () => {
    const list = listAllSurfacesWithTier()
    const expectedCount = Object.values(EXTERNAL_AGENT_ECOSYSTEM_ADAPTERS).reduce(
      (sum, a) => sum + a.surfaces.length,
      0
    )
    expect(list.length).toBe(expectedCount)
    for (const entry of list) {
      expect(entry.adapterId).toBeTruthy()
      expect(entry.adapterName).toBeTruthy()
      expect(entry.surfaceId).toBeTruthy()
      expect(entry.surfaceName).toBeTruthy()
    }
  })
})

describe("resolveExternalAgentSurfaceFromMetadata", () => {
  it("resolves directly via adapterId+surfaceId", () => {
    const out = resolveExternalAgentSurfaceFromMetadata({
      ecosystemAdapterId: "claude-code",
      ecosystemSurfaceId: "acp-stdio",
    })
    expect(out?.adapter.id).toBe("claude-code")
  })

  it("falls back to preset when adapter+surface ids cannot resolve", () => {
    const out = resolveExternalAgentSurfaceFromMetadata({
      ecosystemAdapterId: "wrong",
      ecosystemSurfaceId: "wrong",
      preset: "codex",
    })
    expect(out?.adapter.id).toBe("codex")
  })

  it("uses preset when adapter+surface are missing entirely", () => {
    const out = resolveExternalAgentSurfaceFromMetadata({ preset: "claude-code" })
    expect(out?.adapter.id).toBe("claude-code")
  })

  it("returns null for empty metadata", () => {
    expect(resolveExternalAgentSurfaceFromMetadata(undefined)).toBeNull()
    expect(resolveExternalAgentSurfaceFromMetadata({})).toBeNull()
  })

  it("returns null for entirely unknown ids", () => {
    expect(
      resolveExternalAgentSurfaceFromMetadata({
        ecosystemAdapterId: "unknown",
        ecosystemSurfaceId: "unknown",
      })
    ).toBeNull()
  })

  it("ignores non-string ids gracefully", () => {
    expect(
      resolveExternalAgentSurfaceFromMetadata({
        ecosystemAdapterId: 123 as unknown as string,
        ecosystemSurfaceId: false as unknown as string,
      })
    ).toBeNull()
  })
})
