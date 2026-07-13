import { COGNIA_AGENT } from "./cognia"
import type { McpServer } from "@cognia/agent-config-types"

function mkServer(partial: Pick<McpServer, "name" | "transport" | "config">): McpServer {
  return {
    id: `mcp_${partial.name}`,
    enabled: true,
    appsEnabled: {},
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  }
}

describe("cognia adapter — metadata", () => {
  it("identifies as a writable JSON adapter named Cognia CLI", () => {
    expect(COGNIA_AGENT.id).toBe("cognia")
    expect(COGNIA_AGENT.writable).toBe(true)
    expect(COGNIA_AGENT.format).toBe("json")
    expect(COGNIA_AGENT.displayName).toBe("Cognia CLI")
  })
})

describe("cognia adapter — parse", () => {
  it("returns [] for null / non-object / array input", () => {
    expect(COGNIA_AGENT.parse(null)).toEqual([])
    expect(COGNIA_AGENT.parse("hello")).toEqual([])
    expect(COGNIA_AGENT.parse([])).toEqual([])
  })

  it("returns [] when mcpServers is missing or not an object", () => {
    expect(COGNIA_AGENT.parse({})).toEqual([])
    expect(COGNIA_AGENT.parse({ mcpServers: "not-object" })).toEqual([])
  })

  it("reads stdio entries (type stripped from config)", () => {
    const drafts = COGNIA_AGENT.parse({
      mcpServers: { fs: { type: "stdio", command: "npx", args: ["-y", "fs"] } },
    })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ name: "fs", transport: "stdio" })
    expect(drafts[0].config.command).toBe("npx")
    expect(drafts[0].config).not.toHaveProperty("type")
  })

  it("reads remote (http/sse) entries — unlike Claude Desktop", () => {
    const drafts = COGNIA_AGENT.parse({
      mcpServers: {
        deepwiki: { type: "http", url: "https://mcp.deepwiki.com/mcp" },
        events: { type: "sse", url: "https://x.example/sse" },
      },
    }).sort((a, b) => a.name.localeCompare(b.name))
    expect(drafts).toEqual([
      { name: "deepwiki", transport: "http", config: { url: "https://mcp.deepwiki.com/mcp" } },
      { name: "events", transport: "sse", config: { url: "https://x.example/sse" } },
    ])
  })

  it("drops entries that normalize to null and entries without command/url", () => {
    const names = COGNIA_AGENT.parse({
      mcpServers: {
        empty: null,
        nope: 42,
        bad: { random: "thing" },
        good: { command: "npx" },
      },
    }).map((d) => d.name)
    expect(names).toEqual(["good"])
  })
})

describe("cognia adapter — project", () => {
  it("creates a fresh tree when existing is null", () => {
    const out = COGNIA_AGENT.project(null, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcpServers: Record<string, unknown> }
    expect(out).toEqual({ mcpServers: { fs: { type: "stdio", command: "npx" } } })
  })

  it("writes remote servers with their type discriminator", () => {
    const out = COGNIA_AGENT.project(null, [
      mkServer({ name: "api", transport: "http", config: { url: "https://x.example/mcp" } }),
    ]) as { mcpServers: Record<string, unknown> }
    expect(out.mcpServers.api).toEqual({ type: "http", url: "https://x.example/mcp" })
  })

  it("preserves unmanaged entries and unrelated top-level keys", () => {
    const out = COGNIA_AGENT.project(
      {
        mcpServers: { stranger: { command: "external" }, fs: { command: "old-fs" } },
        someFutureField: 1,
      },
      [mkServer({ name: "fs", transport: "stdio", config: { command: "new-fs" } })]
    ) as Record<string, unknown>
    const map = out.mcpServers as Record<string, unknown>
    expect(map.stranger).toEqual({ command: "external" })
    expect(map.fs).toEqual({ type: "stdio", command: "new-fs" })
    expect(out.someFutureField).toBe(1)
  })

  it("drops a managed entry when omitted from servers but present in managedNames", () => {
    const out = COGNIA_AGENT.project(
      { mcpServers: { fs: { command: "old" }, keep: { command: "k" } } },
      [],
      new Set(["fs"])
    ) as { mcpServers: Record<string, unknown> }
    expect(out.mcpServers.fs).toBeUndefined()
    expect(out.mcpServers.keep).toEqual({ command: "k" })
  })

  it("ignores an mcpServers key whose value is not an object", () => {
    const out = COGNIA_AGENT.project({ mcpServers: "not-object" }, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(out.mcpServers)).toEqual(["fs"])
  })

  it("round-trips: project → parse returns the managed servers", () => {
    const original = [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx", args: ["-y", "fs"] } }),
      mkServer({ name: "api", transport: "http", config: { url: "https://x.example/mcp" } }),
    ]
    const tree = COGNIA_AGENT.project(null, original)
    const drafts = COGNIA_AGENT.parse(tree).sort((a, b) => a.name.localeCompare(b.name))
    expect(drafts).toHaveLength(2)
    expect(drafts[0]).toMatchObject({ name: "api", transport: "http" })
    expect(drafts[1]).toMatchObject({ name: "fs", transport: "stdio" })
  })
})
