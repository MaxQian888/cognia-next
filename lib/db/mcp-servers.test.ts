import { parseClaudeMcpConfig } from "./mcp-servers"

describe("parseClaudeMcpConfig", () => {
  it("returns empty for null / non-object input", () => {
    expect(parseClaudeMcpConfig(null)).toEqual([])
    expect(parseClaudeMcpConfig(undefined)).toEqual([])
    expect(parseClaudeMcpConfig("foo")).toEqual([])
    expect(parseClaudeMcpConfig({})).toEqual([])
  })

  it("returns empty when mcpServers is missing or not an object", () => {
    expect(parseClaudeMcpConfig({ mcpServers: null })).toEqual([])
    expect(parseClaudeMcpConfig({ mcpServers: "x" })).toEqual([])
  })

  it("parses stdio servers without explicit type", () => {
    const drafts = parseClaudeMcpConfig({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
      },
    })
    expect(drafts).toHaveLength(1)
    expect(drafts[0].name).toBe("filesystem")
    expect(drafts[0].transport).toBe("stdio")
    expect(drafts[0].config.command).toBe("npx")
  })

  it("respects explicit type / transport fields", () => {
    const drafts = parseClaudeMcpConfig({
      mcpServers: {
        a: { type: "sse", url: "https://x" },
        b: { transport: "http", url: "https://y" },
      },
    })
    const byName = Object.fromEntries(drafts.map((d) => [d.name, d]))
    expect(byName.a.transport).toBe("sse")
    expect(byName.b.transport).toBe("http")
  })

  it("infers http when url present and no type", () => {
    const drafts = parseClaudeMcpConfig({
      mcpServers: { web: { url: "https://example.com/mcp" } },
    })
    expect(drafts[0].transport).toBe("http")
  })

  it("strips `type` and `transport` from the persisted config", () => {
    const drafts = parseClaudeMcpConfig({
      mcpServers: {
        a: { type: "stdio", command: "npx", args: ["x"] },
      },
    })
    expect(drafts[0].config.type).toBeUndefined()
    expect(drafts[0].config.transport).toBeUndefined()
    expect(drafts[0].config.command).toBe("npx")
  })

  it("skips malformed entries", () => {
    const drafts = parseClaudeMcpConfig({
      mcpServers: {
        good: { command: "npx" },
        bad1: null,
        bad2: "not an object",
      },
    })
    expect(drafts).toHaveLength(1)
    expect(drafts[0].name).toBe("good")
  })
})
