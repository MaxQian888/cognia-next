import { CLAUDE_CODE_AGENT } from "./claude-code"
import type { McpServer } from "@/lib/claude/types"

function mkServer(
  partial: Pick<McpServer, "name" | "transport" | "config"> & {
    enabled?: boolean
    appsEnabled?: McpServer["appsEnabled"]
  }
): McpServer {
  return {
    id: `mcp_${partial.name}`,
    enabled: partial.enabled ?? true,
    appsEnabled: partial.appsEnabled,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  }
}

describe("claude-code adapter — parse", () => {
  it("returns [] for null / non-object input", () => {
    expect(CLAUDE_CODE_AGENT.parse(null)).toEqual([])
    expect(CLAUDE_CODE_AGENT.parse("string")).toEqual([])
    expect(CLAUDE_CODE_AGENT.parse([])).toEqual([])
  })

  it("returns [] when there are no mcpServers anywhere", () => {
    expect(CLAUDE_CODE_AGENT.parse({ other: 1 })).toEqual([])
    expect(CLAUDE_CODE_AGENT.parse({ projects: {} })).toEqual([])
  })

  it("reads root-level stdio entries", () => {
    const drafts = CLAUDE_CODE_AGENT.parse({
      mcpServers: {
        filesystem: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"],
        },
      },
    })
    expect(drafts).toHaveLength(1)
    expect(drafts[0].name).toBe("filesystem")
    expect(drafts[0].transport).toBe("stdio")
    expect(drafts[0].config.command).toBe("npx")
    expect(drafts[0].config).not.toHaveProperty("type")
  })

  it("reads root-level http entries (explicit type)", () => {
    const drafts = CLAUDE_CODE_AGENT.parse({
      mcpServers: {
        deepwiki: { type: "http", url: "https://mcp.deepwiki.com/mcp" },
      },
    })
    expect(drafts).toEqual([
      { name: "deepwiki", transport: "http", config: { url: "https://mcp.deepwiki.com/mcp" } },
    ])
  })

  it("infers http transport when only url is given", () => {
    const drafts = CLAUDE_CODE_AGENT.parse({
      mcpServers: {
        api: { url: "https://api.example.com/mcp", headers: { Authorization: "Bearer X" } },
      },
    })
    expect(drafts[0].transport).toBe("http")
    expect(drafts[0].config.url).toBe("https://api.example.com/mcp")
    expect(drafts[0].config.headers).toEqual({ Authorization: "Bearer X" })
  })

  it("merges entries from projects[*].mcpServers, root takes precedence on collision", () => {
    const drafts = CLAUDE_CODE_AGENT.parse({
      mcpServers: {
        filesystem: { type: "stdio", command: "npx", args: ["/root/scope"] },
      },
      projects: {
        "/Users/me/proj": {
          mcpServers: {
            filesystem: { type: "stdio", command: "npx", args: ["/project/scope"] },
            db: { type: "stdio", command: "dbhub" },
          },
        },
      },
    }).sort((a, b) => a.name.localeCompare(b.name))
    expect(drafts).toHaveLength(2)
    expect(drafts[0]).toMatchObject({ name: "db", transport: "stdio" })
    expect(drafts[1].name).toBe("filesystem")
    expect((drafts[1].config.args as string[])[0]).toBe("/root/scope")
  })

  it("drops malformed entries (no command, no url) but keeps siblings", () => {
    const names = CLAUDE_CODE_AGENT.parse({
      mcpServers: {
        good: { command: "npx" },
        broken: { random: "thing" },
        alsoGood: { url: "https://x.example/mcp" },
      },
    })
      .map((d) => d.name)
      .sort()
    expect(names).toEqual(["alsoGood", "good"])
  })
})

describe("claude-code adapter — project", () => {
  it("creates a fresh tree when existing is null", () => {
    const out = CLAUDE_CODE_AGENT.project(null, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcpServers: Record<string, unknown> }
    expect(out).toEqual({
      mcpServers: { fs: { type: "stdio", command: "npx" } },
    })
  })

  it("preserves unrelated root keys", () => {
    const existing = {
      userId: "abc",
      telemetry: { enabled: false },
      mcpServers: { old: { type: "stdio", command: "old" } },
      otherStuff: [1, 2, 3],
    }
    const out = CLAUDE_CODE_AGENT.project(existing, [
      mkServer({ name: "new", transport: "stdio", config: { command: "new" } }),
    ]) as Record<string, unknown>
    expect(out.userId).toBe("abc")
    expect(out.telemetry).toEqual({ enabled: false })
    expect(out.otherStuff).toEqual([1, 2, 3])
    const mcp = out.mcpServers as Record<string, unknown>
    // `old` was unmanaged → kept; `new` added.
    expect(mcp.old).toEqual({ type: "stdio", command: "old" })
    expect(mcp.new).toEqual({ type: "stdio", command: "new" })
  })

  it("preserves projects[*].mcpServers — only root scope is touched", () => {
    const existing = {
      mcpServers: { keep: { command: "k" } },
      projects: {
        "/path/proj": {
          mcpServers: { local: { command: "l" } },
          otherKey: "preserved",
        },
      },
    }
    const out = CLAUDE_CODE_AGENT.project(existing, [
      mkServer({ name: "fresh", transport: "stdio", config: { command: "f" } }),
    ]) as Record<string, unknown>
    expect((out.projects as Record<string, unknown>)["/path/proj"]).toEqual({
      mcpServers: { local: { command: "l" } },
      otherKey: "preserved",
    })
  })

  it("drops a managed name from the file when it's omitted from `servers` and listed in `managedNames`", () => {
    // Simulates: user had `claude-code` chip on for "fs" (file has fs); they
    // flip the chip off. Sync runs with servers=[] but managedNames={fs} so
    // the entry is removed.
    const existing = {
      mcpServers: {
        fs: { type: "stdio", command: "npx" },
        unmanagedExternal: { type: "stdio", command: "x" },
      },
    }
    const out = CLAUDE_CODE_AGENT.project(
      existing,
      [], // no projected servers
      new Set(["fs"]) // but cognia knows it owns "fs"
    ) as { mcpServers: Record<string, unknown> }
    expect(out.mcpServers.unmanagedExternal).toEqual({ type: "stdio", command: "x" })
    expect(out.mcpServers.fs).toBeUndefined()
  })

  it("removes a tombstoned name (deleted from Dexie) on next sync", () => {
    // After delete: server is gone from Dexie, so `all` doesn't include it.
    // The CRUD layer passes its name as a tombstone via `scheduleSync` so it
    // ends up in managedNames, which drops the entry.
    const existing = {
      mcpServers: {
        keep: { type: "stdio", command: "k" },
        deletedName: { type: "stdio", command: "d" },
        external: { type: "stdio", command: "e" },
      },
    }
    const out = CLAUDE_CODE_AGENT.project(
      existing,
      [mkServer({ name: "keep", transport: "stdio", config: { command: "k" } })],
      new Set(["keep", "deletedName"])
    ) as { mcpServers: Record<string, unknown> }
    expect(out.mcpServers.keep).toEqual({ type: "stdio", command: "k" })
    expect(out.mcpServers.deletedName).toBeUndefined()
    expect(out.mcpServers.external).toEqual({ type: "stdio", command: "e" })
  })

  it("round-trips: project → parse returns the managed servers", () => {
    const original = [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx", args: ["-y", "fs"] } }),
      mkServer({
        name: "api",
        transport: "http",
        config: { url: "https://x.example/mcp", headers: { Authorization: "Bearer X" } },
      }),
    ]
    const tree = CLAUDE_CODE_AGENT.project(null, original)
    const drafts = CLAUDE_CODE_AGENT.parse(tree).sort((a, b) => a.name.localeCompare(b.name))
    expect(drafts).toHaveLength(2)
    expect(drafts[0]).toMatchObject({
      name: "api",
      transport: "http",
      config: { url: "https://x.example/mcp" },
    })
    expect(drafts[1]).toMatchObject({
      name: "fs",
      transport: "stdio",
      config: { command: "npx" },
    })
  })
})
