import type { McpServer } from "@cognia/agent-config-types"

import { WINDSURF_AGENT } from "./windsurf"

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

describe("windsurf adapter — metadata", () => {
  it("is a writable JSON adapter", () => {
    expect(WINDSURF_AGENT.id).toBe("windsurf")
    expect(WINDSURF_AGENT.writable).toBe(true)
    expect(WINDSURF_AGENT.format).toBe("json")
  })
})

describe("windsurf adapter — parse", () => {
  it("returns [] for null / non-object", () => {
    expect(WINDSURF_AGENT.parse(null)).toEqual([])
    expect(WINDSURF_AGENT.parse("x")).toEqual([])
    expect(WINDSURF_AGENT.parse([])).toEqual([])
  })

  it("returns [] when mcpServers is absent or non-object", () => {
    expect(WINDSURF_AGENT.parse({})).toEqual([])
    expect(WINDSURF_AGENT.parse({ mcpServers: 7 })).toEqual([])
  })

  it("renames serverUrl → url on read", () => {
    const drafts = WINDSURF_AGENT.parse({
      mcpServers: {
        api: { serverUrl: "https://your/mcp", headers: { K: "v" } },
      },
    })
    expect(drafts).toEqual([
      {
        name: "api",
        transport: "http",
        config: { url: "https://your/mcp", headers: { K: "v" } },
      },
    ])
  })

  it("parses stdio entries", () => {
    const drafts = WINDSURF_AGENT.parse({
      mcpServers: { fs: { command: "npx" } },
    })
    expect(drafts).toEqual([{ name: "fs", transport: "stdio", config: { command: "npx" } }])
  })

  it("drops unrecognized entries", () => {
    const drafts = WINDSURF_AGENT.parse({
      mcpServers: { good: { command: "g" }, bad: { random: 1 } },
    })
    expect(drafts.map((d) => d.name)).toEqual(["good"])
  })
})

describe("windsurf adapter — project", () => {
  it("creates a fresh tree from null", () => {
    const out = WINDSURF_AGENT.project(null, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.fs).toEqual({ command: "npx" })
  })

  it("creates a fresh tree from non-object existing", () => {
    const out = WINDSURF_AGENT.project(0, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.fs).toEqual({ command: "npx" })
  })

  it("re-stamps url back to serverUrl on http write", () => {
    const out = WINDSURF_AGENT.project(null, [
      mkServer({ name: "api", transport: "http", config: { url: "https://your/mcp" } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.api).toEqual({ serverUrl: "https://your/mcp" })
    expect(out.mcpServers.api.url).toBeUndefined()
  })

  it("preserves unmanaged keys; drops managed names absent from servers", () => {
    const out = WINDSURF_AGENT.project(
      { mcpServers: { keep: { command: "k" }, drop: { command: "d" } }, otherKey: 1 },
      [],
      new Set(["drop"])
    ) as Record<string, unknown>
    expect(out.otherKey).toBe(1)
    const map = out.mcpServers as Record<string, unknown>
    expect(map.keep).toEqual({ command: "k" })
    expect(map.drop).toBeUndefined()
  })

  it("ignores mcpServers when it's not an object", () => {
    const out = WINDSURF_AGENT.project({ mcpServers: false }, [
      mkServer({ name: "x", transport: "stdio", config: { command: "x" } }),
    ]) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(out.mcpServers)).toEqual(["x"])
  })
})
