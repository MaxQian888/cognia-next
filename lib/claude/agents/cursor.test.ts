import type { McpServer } from "@cognia/agent-config-types"

import { CURSOR_AGENT } from "./cursor"

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

describe("cursor adapter — metadata", () => {
  it("is a writable JSON adapter", () => {
    expect(CURSOR_AGENT.id).toBe("cursor")
    expect(CURSOR_AGENT.writable).toBe(true)
    expect(CURSOR_AGENT.format).toBe("json")
  })
})

describe("cursor adapter — parse", () => {
  it("returns [] for null / non-object input", () => {
    expect(CURSOR_AGENT.parse(null)).toEqual([])
    expect(CURSOR_AGENT.parse("x")).toEqual([])
    expect(CURSOR_AGENT.parse([])).toEqual([])
  })

  it("returns [] when mcpServers is missing or non-object", () => {
    expect(CURSOR_AGENT.parse({})).toEqual([])
    expect(CURSOR_AGENT.parse({ mcpServers: "x" })).toEqual([])
  })

  it("infers transport from explicit type / url / command", () => {
    const drafts = CURSOR_AGENT.parse({
      mcpServers: {
        local: { type: "stdio", command: "npx" },
        api: { url: "https://x/mcp" },
        broken: { random: "thing" },
      },
    })
    const byName = Object.fromEntries(drafts.map((d) => [d.name, d]))
    expect(byName.local.transport).toBe("stdio")
    expect(byName.api.transport).toBe("http")
    expect(byName.broken).toBeUndefined()
  })
})

describe("cursor adapter — project", () => {
  it("creates a fresh tree when existing is null", () => {
    const out = CURSOR_AGENT.project(null, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.fs).toEqual({ type: "stdio", command: "npx" })
  })

  it("creates a fresh tree when existing is non-object", () => {
    const out = CURSOR_AGENT.project("nope", [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.fs).toEqual({ type: "stdio", command: "npx" })
  })

  it("preserves unmanaged keys at root", () => {
    const out = CURSOR_AGENT.project({ someOtherKey: 7, mcpServers: { keep: { command: "k" } } }, [
      mkServer({ name: "new", transport: "stdio", config: { command: "n" } }),
    ]) as Record<string, unknown>
    expect(out.someOtherKey).toBe(7)
    expect((out.mcpServers as Record<string, unknown>).keep).toEqual({ command: "k" })
  })

  it("ignores mcpServers if it isn't an object", () => {
    const out = CURSOR_AGENT.project({ mcpServers: 5 }, [
      mkServer({ name: "n", transport: "stdio", config: { command: "x" } }),
    ]) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(out.mcpServers)).toEqual(["n"])
  })

  it("drops a managed name on flush", () => {
    const out = CURSOR_AGENT.project(
      { mcpServers: { fs: { command: "old" }, x: { command: "x" } } },
      [],
      new Set(["fs"])
    ) as { mcpServers: Record<string, unknown> }
    expect(out.mcpServers.fs).toBeUndefined()
    expect(out.mcpServers.x).toEqual({ command: "x" })
  })

  it("emits type discriminator for http servers", () => {
    const out = CURSOR_AGENT.project(null, [
      mkServer({ name: "api", transport: "http", config: { url: "https://x" } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.api).toEqual({ type: "http", url: "https://x" })
  })
})
