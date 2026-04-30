import type { McpServer } from "@/lib/claude/types"

import { CLAUDE_DESKTOP_AGENT } from "./claude-desktop"

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

describe("claude-desktop adapter — metadata", () => {
  it("identifies as a writable JSON adapter", () => {
    expect(CLAUDE_DESKTOP_AGENT.id).toBe("claude-desktop")
    expect(CLAUDE_DESKTOP_AGENT.writable).toBe(true)
    expect(CLAUDE_DESKTOP_AGENT.format).toBe("json")
    expect(CLAUDE_DESKTOP_AGENT.displayName).toBe("Claude Desktop")
  })
})

describe("claude-desktop adapter — parse", () => {
  it("returns [] for null / non-object input", () => {
    expect(CLAUDE_DESKTOP_AGENT.parse(null)).toEqual([])
    expect(CLAUDE_DESKTOP_AGENT.parse("hello")).toEqual([])
    expect(CLAUDE_DESKTOP_AGENT.parse([])).toEqual([])
  })

  it("returns [] when mcpServers is missing or not an object", () => {
    expect(CLAUDE_DESKTOP_AGENT.parse({})).toEqual([])
    expect(CLAUDE_DESKTOP_AGENT.parse({ mcpServers: "not-object" })).toEqual([])
  })

  it("forces stdio even when a stray url field is present", () => {
    const drafts = CLAUDE_DESKTOP_AGENT.parse({
      mcpServers: { weird: { command: "x", url: "https://x" } },
    })
    expect(drafts).toEqual([
      { name: "weird", transport: "stdio", config: { command: "x", url: "https://x" } },
    ])
  })

  it("drops entries that normalize to null and entries without a command", () => {
    const drafts = CLAUDE_DESKTOP_AGENT.parse({
      mcpServers: {
        empty: null,
        nope: 42,
        bad: { random: "thing" }, // no command → dropped at dropInvalidDrafts
        good: { command: "npx" },
      },
    })
    expect(drafts.map((d) => d.name)).toEqual(["good"])
  })
})

describe("claude-desktop adapter — project", () => {
  it("creates a fresh tree when existing is null", () => {
    const out = CLAUDE_DESKTOP_AGENT.project(null, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcpServers: Record<string, unknown> }
    expect(out.mcpServers.fs).toEqual({ command: "npx" })
  })

  it("creates a fresh tree when existing is a non-object value", () => {
    const out = CLAUDE_DESKTOP_AGENT.project(42, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcpServers: Record<string, unknown> }
    expect(out.mcpServers.fs).toEqual({ command: "npx" })
  })

  it("preserves unmanaged entries (cognia doesn't own them)", () => {
    const out = CLAUDE_DESKTOP_AGENT.project(
      {
        mcpServers: {
          stranger: { command: "external" },
          fs: { command: "old-fs" },
        },
        topLevelStuff: 1,
      },
      [mkServer({ name: "fs", transport: "stdio", config: { command: "new-fs" } })]
    ) as Record<string, unknown>
    const map = out.mcpServers as Record<string, unknown>
    expect(map.stranger).toEqual({ command: "external" })
    expect(map.fs).toEqual({ command: "new-fs" })
    expect(out.topLevelStuff).toBe(1)
  })

  it("drops a managed entry when omitted from servers but present in managedNames", () => {
    const out = CLAUDE_DESKTOP_AGENT.project(
      { mcpServers: { fs: { command: "old" }, keep: { command: "k" } } },
      [],
      new Set(["fs"])
    ) as { mcpServers: Record<string, unknown> }
    expect(out.mcpServers.fs).toBeUndefined()
    expect(out.mcpServers.keep).toEqual({ command: "k" })
  })

  it("skips remote servers because the format is stdio-only", () => {
    const out = CLAUDE_DESKTOP_AGENT.project(null, [
      mkServer({ name: "api", transport: "http", config: { url: "https://x" } }),
      mkServer({ name: "evt", transport: "sse", config: { url: "https://x/sse" } }),
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(out.mcpServers)).toEqual(["fs"])
  })

  it("ignores an mcpServers key whose value is not an object", () => {
    const out = CLAUDE_DESKTOP_AGENT.project({ mcpServers: "not-object" }, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(out.mcpServers)).toEqual(["fs"])
  })
})
