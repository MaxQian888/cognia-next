import type { McpServer } from "@cognia/agent-config-types"
import { PI_MCP_ADAPTER_AGENT, PI_MCP_ADAPTER_PACKAGE } from "./pi-mcp-adapter"

const { parse, project } = PI_MCP_ADAPTER_AGENT

function server(partial: Partial<McpServer> & Pick<McpServer, "name" | "transport">): McpServer {
  return { id: partial.name, config: {}, ...partial } as McpServer
}

describe("PI_MCP_ADAPTER_AGENT metadata", () => {
  it("keeps the persisted MCP target id separate from Pi settings", () => {
    expect(PI_MCP_ADAPTER_AGENT.id).toBe("pi-mcp-adapter")
    expect(PI_MCP_ADAPTER_AGENT.displayName).toBe("Pi")
    expect(PI_MCP_ADAPTER_AGENT.description).not.toContain("requires")
    expect(PI_MCP_ADAPTER_AGENT.writable).toBe(true)
    expect(PI_MCP_ADAPTER_AGENT.format).toBe("json")
  })

  it("retains the optional legacy package identity", () => {
    expect(PI_MCP_ADAPTER_PACKAGE).toBe("pi-mcp-adapter")
  })
})

describe("parse", () => {
  it("reads stdio servers", () => {
    expect(
      parse({ mcpServers: { fs: { command: "npx", args: ["-y", "server-filesystem"] } } })
    ).toEqual([
      {
        name: "fs",
        transport: "stdio",
        config: { command: "npx", args: ["-y", "server-filesystem"] },
      },
    ])
  })

  /** `config.ts` reads `raw.mcpServers ?? raw["mcp-servers"]`. */
  it("accepts the hyphenated key spelling", () => {
    expect(parse({ "mcp-servers": { fs: { command: "npx" } } })).toEqual([
      { name: "fs", transport: "stdio", config: { command: "npx" } },
    ])
  })

  it("treats a bare url as HTTP", () => {
    expect(parse({ mcpServers: { api: { url: "https://example.com/mcp" } } })).toEqual([
      { name: "api", transport: "http", config: { url: "https://example.com/mcp" } },
    ])
  })

  /**
   * The adapter has no `type` field, so SSE is only recoverable from
   * `httpTransport`. Without this branch every SSE server silently reads back
   * as HTTP.
   */
  it("recovers SSE from httpTransport and consumes the marker", () => {
    expect(
      parse({ mcpServers: { api: { url: "https://example.com/sse", httpTransport: "sse" } } })
    ).toEqual([{ name: "api", transport: "sse", config: { url: "https://example.com/sse" } }])
  })

  it("folds streamable-http into http", () => {
    const [entry] = parse({
      mcpServers: { api: { url: "https://example.com/mcp", httpTransport: "streamable-http" } },
    })
    expect(entry.transport).toBe("http")
    expect(entry.config.httpTransport).toBeUndefined()
  })

  it("keeps adapter-specific fields Cognia does not model", () => {
    const [entry] = parse({
      mcpServers: { fs: { command: "npx", disabled: true, excludeTools: ["write"] } },
    })
    expect(entry.config).toMatchObject({ disabled: true, excludeTools: ["write"] })
  })

  it("returns [] for shapes it cannot read", () => {
    expect(parse(null)).toEqual([])
    expect(parse([])).toEqual([])
    expect(parse({})).toEqual([])
    expect(parse({ mcpServers: [] })).toEqual([])
  })

  it("drops an entry with neither command nor url", () => {
    expect(parse({ mcpServers: { broken: { env: { A: "1" } } } })).toEqual([])
  })
})

describe("project", () => {
  it("writes no type discriminator — ServerEntry has no such field", () => {
    const out = project(null, [
      server({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ])
    expect(out).toEqual({ mcpServers: { fs: { command: "npx" } } })
  })

  it("rejects unsupported SSE before producing a destructive projection", () => {
    const existing = {
      autoEnableCodemode: false,
      mcpServers: {
        sse: { url: "https://example.com/sse", httpTransport: "sse" },
        unmanaged: { command: "keep" },
      },
    }
    const snapshot = structuredClone(existing)
    const projectUnsupported = () =>
      project(
        existing,
        [server({ name: "sse", transport: "sse", config: { url: "https://example.com/sse" } })],
        new Set(["sse"])
      )
    expect(projectUnsupported).toThrow(TypeError)
    expect(projectUnsupported).toThrow(/Pi.*does not support SSE.*sse/)
    expect(existing).toEqual(snapshot)
  })

  it("preserves native OAuth, exposure, enabled state and project override entries", () => {
    const config = {
      url: "https://example.com/mcp",
      enabled: false,
      exposure: "deferred",
      toolExposure: { "read_*": "direct" },
      oauth: { clientRegistration: "cimd", authServerMetadataUrl: "https://example.com/oauth" },
    }
    const written = project(
      {
        autoEnableCodemode: false,
        mcpServers: { override: { enabled: false, exposure: "hidden" } },
      },
      [server({ name: "api", transport: "http", config })]
    )
    expect(written).toEqual({
      autoEnableCodemode: false,
      mcpServers: { override: { enabled: false, exposure: "hidden" }, api: config },
    })
    expect(parse(written)).toEqual([{ name: "api", transport: "http", config }])
  })

  it("leaves HTTP unpinned so the adapter can negotiate", () => {
    const out = project(null, [
      server({ name: "api", transport: "http", config: { url: "https://example.com/mcp" } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.api.httpTransport).toBeUndefined()
  })

  it("preserves unmanaged servers", () => {
    const out = project(
      { mcpServers: { theirs: { command: "their-cmd" } } },
      [server({ name: "ours", transport: "stdio", config: { command: "our-cmd" } })],
      new Set(["ours"])
    )
    expect(out).toEqual({
      mcpServers: { theirs: { command: "their-cmd" }, ours: { command: "our-cmd" } },
    })
  })

  it("drops a managed server that is no longer projected", () => {
    const out = project({ mcpServers: { gone: { command: "x" } } }, [], new Set(["gone"]))
    expect(out).toEqual({ mcpServers: {} })
  })

  /**
   * The file also carries the adapter's own `settings` / `imports` blocks.
   * Serializing only `mcpServers` would delete a user's entire tool budget and
   * import configuration.
   */
  it("preserves unmanaged top-level keys", () => {
    const out = project(
      { settings: { toolPrefix: "short" }, imports: ["cursor"], mcpServers: {} },
      [server({ name: "fs", transport: "stdio", config: { command: "npx" } })]
    )
    expect(out).toMatchObject({ settings: { toolPrefix: "short" }, imports: ["cursor"] })
  })

  /** Rewriting the key would show up as an unexplained hand-edit in a diff. */
  it("migrates the legacy hyphenated key to native Pi mcpServers", () => {
    const out = project({ "mcp-servers": { old: { command: "x" } } }, [
      server({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as Record<string, unknown>
    expect(out.mcpServers).toEqual({ old: { command: "x" }, fs: { command: "npx" } })
    expect(out["mcp-servers"]).toBeUndefined()
  })

  it("defaults to the canonical key on a fresh file", () => {
    expect(project(null, [])).toEqual({ mcpServers: {} })
  })
})
