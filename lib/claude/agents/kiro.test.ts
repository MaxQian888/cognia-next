import type { McpServer } from "@cognia/agent-config-types"

import { KIRO_AGENT } from "./kiro"

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

describe("kiro adapter — metadata", () => {
  it("is a writable JSON adapter", () => {
    expect(KIRO_AGENT.id).toBe("kiro")
    expect(KIRO_AGENT.writable).toBe(true)
    expect(KIRO_AGENT.format).toBe("json")
  })
})

describe("kiro adapter — parse", () => {
  it("returns [] for null / non-object input", () => {
    expect(KIRO_AGENT.parse(null)).toEqual([])
    expect(KIRO_AGENT.parse("x")).toEqual([])
    expect(KIRO_AGENT.parse([])).toEqual([])
  })

  it("returns [] when mcpServers is missing or non-object", () => {
    expect(KIRO_AGENT.parse({})).toEqual([])
    expect(KIRO_AGENT.parse({ mcpServers: "x" })).toEqual([])
  })

  it("infers transport structurally — Kiro writes no type key", () => {
    const drafts = KIRO_AGENT.parse({
      mcpServers: {
        local: { command: "npx", args: ["-y", "pkg"] },
        api: { url: "https://x/mcp" },
        broken: { random: "thing" },
      },
    })
    const byName = Object.fromEntries(drafts.map((d) => [d.name, d]))
    expect(byName.local.transport).toBe("stdio")
    expect(byName.api.transport).toBe("http")
    expect(byName.broken).toBeUndefined()
  })

  it("strips Kiro-only lifecycle keys so they can't leak to other agents", () => {
    const drafts = KIRO_AGENT.parse({
      mcpServers: {
        fs: {
          command: "npx",
          disabled: true,
          autoApprove: ["*"],
          disabledTools: ["rm"],
        },
      },
    })
    expect(drafts[0].config).toEqual({ command: "npx" })
  })
})

describe("kiro adapter — project", () => {
  it("creates a fresh tree with no type discriminator", () => {
    const out = KIRO_AGENT.project(null, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.fs).toEqual({ command: "npx" })
  })

  it("writes remote servers as a bare url, no type", () => {
    const out = KIRO_AGENT.project(null, [
      mkServer({ name: "api", transport: "http", config: { url: "https://x" } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.api).toEqual({ url: "https://x" })
  })

  it("preserves unmanaged keys at root and unmanaged servers", () => {
    const out = KIRO_AGENT.project({ someOtherKey: 7, mcpServers: { keep: { command: "k" } } }, [
      mkServer({ name: "new", transport: "stdio", config: { command: "n" } }),
    ]) as Record<string, unknown>
    expect(out.someOtherKey).toBe(7)
    expect((out.mcpServers as Record<string, unknown>).keep).toEqual({ command: "k" })
  })

  it("carries Kiro's own disabled/autoApprove across a sync", () => {
    const out = KIRO_AGENT.project(
      { mcpServers: { fs: { command: "old", disabled: true, autoApprove: ["read"] } } },
      [mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } })]
    ) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.fs).toEqual({
      command: "npx",
      disabled: true,
      autoApprove: ["read"],
    })
  })

  it("ignores mcpServers if it isn't an object", () => {
    const out = KIRO_AGENT.project({ mcpServers: 5 }, [
      mkServer({ name: "n", transport: "stdio", config: { command: "x" } }),
    ]) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(out.mcpServers)).toEqual(["n"])
  })

  it("drops a managed name on flush", () => {
    const out = KIRO_AGENT.project(
      { mcpServers: { fs: { command: "old" }, x: { command: "x" } } },
      [],
      new Set(["fs"])
    ) as { mcpServers: Record<string, unknown> }
    expect(out.mcpServers.fs).toBeUndefined()
    expect(out.mcpServers.x).toEqual({ command: "x" })
  })
})
