import type { McpServer } from "@cognia/agent-config-types"
import { PI_MCP_ADAPTER_AGENT, PI_MCP_ADAPTER_PACKAGE } from "./pi-mcp-adapter"

const { parse, project } = PI_MCP_ADAPTER_AGENT

function server(partial: Partial<McpServer> & Pick<McpServer, "name" | "transport">): McpServer {
  return { id: partial.name, config: {}, ...partial } as McpServer
}

describe("PI_MCP_ADAPTER_AGENT metadata", () => {
  it("is a writable JSON adapter under its own id, not Pi's", () => {
    expect(PI_MCP_ADAPTER_AGENT.id).toBe("pi-mcp-adapter")
    expect(PI_MCP_ADAPTER_AGENT.writable).toBe(true)
    expect(PI_MCP_ADAPTER_AGENT.format).toBe("json")
  })

  it("names the npm package the whole surface is gated on", () => {
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

  it("pins SSE with httpTransport so the round-trip is lossless", () => {
    const written = project(null, [
      server({ name: "api", transport: "sse", config: { url: "https://example.com/sse" } }),
    ])
    expect(written).toEqual({
      mcpServers: { api: { url: "https://example.com/sse", httpTransport: "sse" } },
    })
    expect(parse(written)[0].transport).toBe("sse")
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
  it("keeps the hyphenated key when the file already uses it", () => {
    const out = project({ "mcp-servers": { old: { command: "x" } } }, [
      server({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as Record<string, unknown>
    expect(out["mcp-servers"]).toEqual({ old: { command: "x" }, fs: { command: "npx" } })
    expect(out.mcpServers).toBeUndefined()
  })

  it("defaults to the canonical key on a fresh file", () => {
    expect(project(null, [])).toEqual({ mcpServers: {} })
  })
})
