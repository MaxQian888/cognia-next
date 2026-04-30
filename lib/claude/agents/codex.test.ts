import type { McpServer } from "@/lib/claude/types"

import { CODEX_AGENT } from "./codex"

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

describe("codex adapter — metadata", () => {
  it("is a writable TOML adapter", () => {
    expect(CODEX_AGENT.id).toBe("codex")
    expect(CODEX_AGENT.writable).toBe(true)
    expect(CODEX_AGENT.format).toBe("toml")
  })
})

describe("codex adapter — parse", () => {
  it("returns [] for null / non-object / array input", () => {
    expect(CODEX_AGENT.parse(null)).toEqual([])
    expect(CODEX_AGENT.parse("x")).toEqual([])
    expect(CODEX_AGENT.parse([])).toEqual([])
  })

  it("returns [] when neither key is present", () => {
    expect(CODEX_AGENT.parse({})).toEqual([])
    expect(CODEX_AGENT.parse({ mcp_servers: "not-object" })).toEqual([])
  })

  it("reads from canonical mcp_servers", () => {
    const drafts = CODEX_AGENT.parse({
      mcp_servers: { docs: { command: "docs", args: ["--x"] } },
    })
    expect(drafts).toEqual([
      { name: "docs", transport: "stdio", config: { command: "docs", args: ["--x"] } },
    ])
  })

  it("reads from the typo'd mcp.servers when canonical is absent", () => {
    const drafts = CODEX_AGENT.parse({
      "mcp.servers": { docs: { command: "d" } },
    })
    expect(drafts).toEqual([{ name: "docs", transport: "stdio", config: { command: "d" } }])
  })

  it("prefers canonical key over the typo when both are present", () => {
    const drafts = CODEX_AGENT.parse({
      mcp_servers: { docs: { command: "canon" } },
      "mcp.servers": { docs: { command: "typo" } },
    })
    expect(drafts).toEqual([{ name: "docs", transport: "stdio", config: { command: "canon" } }])
  })

  it("drops entries with no command and no url", () => {
    const drafts = CODEX_AGENT.parse({
      mcp_servers: { broken: {}, ok: { command: "x" } },
    })
    expect(drafts.map((d) => d.name)).toEqual(["ok"])
  })

  it("parses remote entries as http", () => {
    const drafts = CODEX_AGENT.parse({
      mcp_servers: {
        api: { url: "https://api.example/mcp", http_headers: { K: "v" } },
      },
    })
    expect(drafts[0]).toMatchObject({
      name: "api",
      transport: "http",
      config: { url: "https://api.example/mcp", http_headers: { K: "v" } },
    })
  })
})

describe("codex adapter — project", () => {
  it("creates a fresh tree from null", () => {
    const out = CODEX_AGENT.project(null, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcp_servers: Record<string, Record<string, unknown>> }
    expect(out.mcp_servers.fs).toEqual({ command: "npx" })
  })

  it("creates a fresh tree from a non-object existing", () => {
    const out = CODEX_AGENT.project("oops", [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcp_servers: Record<string, Record<string, unknown>> }
    expect(out.mcp_servers.fs).toEqual({ command: "npx" })
  })

  it("canonicalizes the typo'd key on write", () => {
    const out = CODEX_AGENT.project({ "mcp.servers": { docs: { command: "old" } } }, [
      mkServer({ name: "docs", transport: "stdio", config: { command: "new" } }),
    ]) as Record<string, unknown>
    expect(out["mcp.servers"]).toBeUndefined()
    expect((out.mcp_servers as Record<string, Record<string, unknown>>).docs).toEqual({
      command: "new",
    })
  })

  it("drops every name in managedNames before re-stamping the active subset", () => {
    const out = CODEX_AGENT.project(
      {
        mcp_servers: {
          a: { command: "a-old" },
          b: { command: "b-old" },
          ext: { command: "external" },
        },
      },
      [mkServer({ name: "a", transport: "stdio", config: { command: "a-new" } })],
      new Set(["a", "b"])
    ) as { mcp_servers: Record<string, Record<string, unknown>> }
    expect(out.mcp_servers.a).toEqual({ command: "a-new" })
    expect(out.mcp_servers.b).toBeUndefined()
    expect(out.mcp_servers.ext).toEqual({ command: "external" })
  })

  it("skips SSE-only servers because Codex speaks streamable HTTP", () => {
    const out = CODEX_AGENT.project(null, [
      mkServer({ name: "evt", transport: "sse", config: { url: "https://sse/x" } }),
      mkServer({ name: "ok", transport: "stdio", config: { command: "ok" } }),
    ]) as { mcp_servers: Record<string, unknown> }
    expect(Object.keys(out.mcp_servers)).toEqual(["ok"])
  })

  it("preserves non-mcp top-level TOML keys", () => {
    const out = CODEX_AGENT.project(
      { model: "gpt-5", custom: { x: 1 }, mcp_servers: { keep: { command: "k" } } },
      [mkServer({ name: "added", transport: "stdio", config: { command: "a" } })]
    ) as Record<string, unknown>
    expect(out.model).toBe("gpt-5")
    expect(out.custom).toEqual({ x: 1 })
    const m = out.mcp_servers as Record<string, Record<string, unknown>>
    expect(m.keep).toEqual({ command: "k" })
    expect(m.added).toEqual({ command: "a" })
  })
})
