// Cross-adapter sanity tests. Each writable adapter must:
//   1. parse a real-shape fixture losslessly into McpImportDraft[]
//   2. project + parse round-trip (output of project ⊇ input servers)
//   3. preserve unmanaged keys present in the existing tree
//
// Read-only adapters (cline, roo-code) only need (1).

import type { McpServer } from "@/lib/claude/types"
import {
  CLAUDE_CODE_AGENT,
  CLAUDE_DESKTOP_AGENT,
  CLINE_AGENT,
  CODEX_AGENT,
  CURSOR_AGENT,
  GEMINI_AGENT,
  ROO_CODE_AGENT,
  VSCODE_AGENT,
  WINDSURF_AGENT,
} from "./index"
import { MCP_AGENT_ADAPTERS, getAgentAdapter } from "./index"

function mkServer(
  name: string,
  transport: McpServer["transport"],
  config: Record<string, unknown>
): McpServer {
  return {
    id: `mcp_${name}`,
    name,
    transport,
    config,
    enabled: true,
    appsEnabled: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("registry", () => {
  it("exposes a known set of adapters", () => {
    const ids = MCP_AGENT_ADAPTERS.map((a) => a.id).sort()
    expect(ids).toEqual(
      [
        "claude-code",
        "claude-desktop",
        "cline",
        "codex",
        "cursor",
        "gemini",
        "roo-code",
        "vscode",
        "windsurf",
      ].sort()
    )
  })

  it("lookups via id work", () => {
    expect(getAgentAdapter("claude-code")).toBe(CLAUDE_CODE_AGENT)
    expect(getAgentAdapter("vscode")).toBe(VSCODE_AGENT)
  })
})

describe("claude-desktop adapter", () => {
  it("parses stdio entries (no `type` discriminator on disk)", () => {
    const drafts = CLAUDE_DESKTOP_AGENT.parse({
      mcpServers: {
        fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/x"] },
      },
    })
    expect(drafts).toEqual([
      {
        name: "fs",
        transport: "stdio",
        config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/x"] },
      },
    ])
  })

  it("emits no `type` key on serialize", () => {
    const out = CLAUDE_DESKTOP_AGENT.project(null, [
      mkServer("fs", "stdio", { command: "npx" }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.fs).toEqual({ command: "npx" })
    expect(out.mcpServers.fs).not.toHaveProperty("type")
  })

  it("skips remote servers (file format is stdio-only)", () => {
    const out = CLAUDE_DESKTOP_AGENT.project(null, [
      mkServer("api", "http", { url: "https://x/mcp" }),
      mkServer("fs", "stdio", { command: "npx" }),
    ]) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(out.mcpServers)).toEqual(["fs"])
  })
})

describe("cursor adapter", () => {
  it("parses stdio + remote with type inference", () => {
    const drafts = CURSOR_AGENT.parse({
      mcpServers: {
        local: { type: "stdio", command: "npx" },
        api: { url: "https://x/mcp" },
      },
    })
    expect(drafts).toEqual(
      expect.arrayContaining([
        { name: "local", transport: "stdio", config: { command: "npx" } },
        { name: "api", transport: "http", config: { url: "https://x/mcp" } },
      ])
    )
  })

  it("preserves unmanaged keys at root", () => {
    const out = CURSOR_AGENT.project(
      { someOtherCursorKey: 123, mcpServers: { keep: { command: "k" } } },
      [mkServer("new", "stdio", { command: "n" })]
    ) as Record<string, unknown>
    expect(out.someOtherCursorKey).toBe(123)
    expect((out.mcpServers as Record<string, unknown>).keep).toEqual({ command: "k" })
  })
})

describe("vscode adapter — top-level key is `servers`", () => {
  it("does NOT read from `mcpServers` (would silently miss everything)", () => {
    const drafts = VSCODE_AGENT.parse({
      mcpServers: { wrong: { command: "x" } },
    })
    expect(drafts).toEqual([])
  })

  it("reads from `servers`", () => {
    const drafts = VSCODE_AGENT.parse({
      servers: {
        playwright: { type: "stdio", command: "npx", args: ["-y", "playwright-mcp"] },
        gh: { type: "http", url: "https://api.githubcopilot.com/mcp" },
      },
    })
    const byName = Object.fromEntries(drafts.map((d) => [d.name, d]))
    expect(byName.playwright.transport).toBe("stdio")
    expect(byName.gh.transport).toBe("http")
  })

  it("emits `servers` and preserves user `inputs[]` array", () => {
    const out = VSCODE_AGENT.project(
      { servers: { keep: { type: "stdio", command: "k" } }, inputs: [{ id: "tok" }] },
      [mkServer("new", "http", { url: "https://x/mcp" })]
    ) as Record<string, unknown>
    expect(out.inputs).toEqual([{ id: "tok" }])
    const servers = out.servers as Record<string, Record<string, unknown>>
    expect(servers.keep).toEqual({ type: "stdio", command: "k" })
    expect(servers.new).toEqual({ type: "http", url: "https://x/mcp" })
  })
})

describe("codex adapter — TOML-shaped JSON tree", () => {
  it("reads from canonical mcp_servers table", () => {
    const drafts = CODEX_AGENT.parse({
      mcp_servers: {
        docs: { command: "docs-server", args: ["--flag"] },
        remote: { url: "https://api.example.com/mcp", http_headers: { "X-K": "v" } },
      },
    })
    const byName = Object.fromEntries(drafts.map((d) => [d.name, d]))
    expect(byName.docs.transport).toBe("stdio")
    expect(byName.remote.transport).toBe("http")
    expect(byName.remote.config.http_headers).toEqual({ "X-K": "v" })
  })

  it("tolerates the typo'd `mcp.servers` key on read", () => {
    const drafts = CODEX_AGENT.parse({
      "mcp.servers": { docs: { command: "docs-server" } },
    })
    expect(drafts).toEqual([
      { name: "docs", transport: "stdio", config: { command: "docs-server" } },
    ])
  })

  it("canonicalizes the typo'd key on write", () => {
    const out = CODEX_AGENT.project({ "mcp.servers": { docs: { command: "old" } } }, [
      mkServer("docs", "stdio", { command: "new" }),
    ]) as Record<string, unknown>
    expect(out["mcp.servers"]).toBeUndefined()
    expect((out.mcp_servers as Record<string, Record<string, unknown>>).docs).toEqual({
      command: "new",
    })
  })

  it("preserves non-mcp top-level TOML sections", () => {
    const out = CODEX_AGENT.project(
      {
        model: "gpt-5",
        custom_section: { foo: "bar" },
        mcp_servers: { keep: { command: "k" } },
      },
      [mkServer("added", "stdio", { command: "a" })]
    ) as Record<string, unknown>
    expect(out.model).toBe("gpt-5")
    expect(out.custom_section).toEqual({ foo: "bar" })
    const m = out.mcp_servers as Record<string, Record<string, unknown>>
    expect(m.keep).toEqual({ command: "k" })
    expect(m.added).toEqual({ command: "a" })
  })

  it("skips SSE-only servers (Codex doesn't support SSE)", () => {
    const out = CODEX_AGENT.project(null, [
      mkServer("sse-only", "sse", { url: "https://sse.example/mcp" }),
      mkServer("ok", "stdio", { command: "ok" }),
    ]) as { mcp_servers: Record<string, unknown> }
    expect(Object.keys(out.mcp_servers)).toEqual(["ok"])
  })
})

describe("gemini adapter — url=SSE, httpUrl=HTTP discriminator", () => {
  it("reads command → stdio, url → sse, httpUrl → http (canonicalizes httpUrl to url)", () => {
    const drafts = GEMINI_AGENT.parse({
      mcpServers: {
        local: { command: "py", args: ["-m", "srv"] },
        sse: { url: "https://sse.example/mcp" },
        http: { httpUrl: "http://localhost:3000/mcp", headers: { Authorization: "Bearer t" } },
      },
    })
    const byName = Object.fromEntries(drafts.map((d) => [d.name, d]))
    expect(byName.local.transport).toBe("stdio")
    expect(byName.sse.transport).toBe("sse")
    expect(byName.http.transport).toBe("http")
    // Internal draft uses canonical `url`; httpUrl is gemini's on-disk quirk.
    expect(byName.http.config.url).toBe("http://localhost:3000/mcp")
    expect(byName.http.config.httpUrl).toBeUndefined()
  })

  it("re-stamps url under httpUrl on http write", () => {
    const out = GEMINI_AGENT.project(null, [
      mkServer("api", "http", { url: "https://api.example/mcp", headers: { K: "v" } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.api.url).toBeUndefined()
    expect(out.mcpServers.api.httpUrl).toBe("https://api.example/mcp")
    expect(out.mcpServers.api.headers).toEqual({ K: "v" })
  })

  it("keeps url for SSE write", () => {
    const out = GEMINI_AGENT.project(null, [
      mkServer("evt", "sse", { url: "https://sse/mcp" }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.evt).toEqual({ url: "https://sse/mcp" })
  })
})

describe("windsurf adapter — serverUrl quirk", () => {
  it("reads `serverUrl` and canonicalizes to `url`", () => {
    const drafts = WINDSURF_AGENT.parse({
      mcpServers: {
        api: { serverUrl: "https://your/mcp", headers: { K: "v" } },
      },
    })
    expect(drafts[0]).toMatchObject({
      name: "api",
      transport: "http",
      config: { url: "https://your/mcp", headers: { K: "v" } },
    })
  })

  it("re-stamps url back to serverUrl on write", () => {
    const out = WINDSURF_AGENT.project(null, [
      mkServer("api", "http", { url: "https://your/mcp" }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.api.url).toBeUndefined()
    expect(out.mcpServers.api.serverUrl).toBe("https://your/mcp")
  })
})

describe("read-only adapters (cline, roo-code)", () => {
  it("cline parses but throws on project", () => {
    const drafts = CLINE_AGENT.parse({
      mcpServers: { x: { command: "x" } },
    })
    expect(drafts).toEqual([{ name: "x", transport: "stdio", config: { command: "x" } }])
    expect(() => CLINE_AGENT.project(null, [])).toThrow(/read-only/)
  })

  it("roo-code folds streamable-http into http", () => {
    const drafts = ROO_CODE_AGENT.parse({
      mcpServers: { x: { type: "streamable-http", url: "https://x/mcp" } },
    })
    expect(drafts[0].transport).toBe("http")
    expect(() => ROO_CODE_AGENT.project(null, [])).toThrow(/read-only/)
  })
})
