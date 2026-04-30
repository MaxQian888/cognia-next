import type { McpServer } from "@/lib/claude/types"

import { GEMINI_AGENT } from "./gemini"

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

describe("gemini adapter — metadata", () => {
  it("is a writable JSON adapter", () => {
    expect(GEMINI_AGENT.id).toBe("gemini")
    expect(GEMINI_AGENT.writable).toBe(true)
    expect(GEMINI_AGENT.format).toBe("json")
  })
})

describe("gemini adapter — parse", () => {
  it("returns [] for null / non-object input", () => {
    expect(GEMINI_AGENT.parse(null)).toEqual([])
    expect(GEMINI_AGENT.parse("x")).toEqual([])
    expect(GEMINI_AGENT.parse([])).toEqual([])
  })

  it("returns [] when mcpServers is missing or non-object", () => {
    expect(GEMINI_AGENT.parse({})).toEqual([])
    expect(GEMINI_AGENT.parse({ mcpServers: 5 })).toEqual([])
  })

  it("infers stdio from command, sse from url, http from httpUrl", () => {
    const drafts = GEMINI_AGENT.parse({
      mcpServers: {
        local: { command: "x", args: ["y"] },
        sse: { url: "https://sse/x" },
        http: { httpUrl: "http://localhost:3000/mcp", headers: { K: "v" } },
        bogus: { type: "garbage" }, // gets skipped
      },
    })
    const byName = Object.fromEntries(drafts.map((d) => [d.name, d]))
    expect(byName.local.transport).toBe("stdio")
    expect(byName.sse.transport).toBe("sse")
    expect(byName.http.transport).toBe("http")
    expect(byName.http.config.url).toBe("http://localhost:3000/mcp")
    expect(byName.http.config.httpUrl).toBeUndefined()
    expect(byName.bogus).toBeUndefined()
  })

  it("ignores entries that are not objects", () => {
    const drafts = GEMINI_AGENT.parse({
      mcpServers: { skipped: null, ok: { command: "x" } },
    })
    expect(drafts.map((d) => d.name)).toEqual(["ok"])
  })
})

describe("gemini adapter — project", () => {
  it("creates a fresh tree from null", () => {
    const out = GEMINI_AGENT.project(null, [
      mkServer({ name: "local", transport: "stdio", config: { command: "x" } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.local).toEqual({ command: "x" })
  })

  it("creates a fresh tree from non-object existing", () => {
    const out = GEMINI_AGENT.project("nope", [
      mkServer({ name: "local", transport: "stdio", config: { command: "x" } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.local).toEqual({ command: "x" })
  })

  it("emits httpUrl for http servers, url for sse", () => {
    const out = GEMINI_AGENT.project(null, [
      mkServer({
        name: "api",
        transport: "http",
        config: { url: "https://x", headers: { k: "v" } },
      }),
      mkServer({ name: "evt", transport: "sse", config: { url: "https://sse/x" } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.api).toEqual({ httpUrl: "https://x", headers: { k: "v" } })
    expect(out.mcpServers.evt).toEqual({ url: "https://sse/x" })
  })

  it("emits stdio servers as plain command", () => {
    const out = GEMINI_AGENT.project(null, [
      mkServer({ name: "local", transport: "stdio", config: { command: "py", args: ["m"] } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.local).toEqual({ command: "py", args: ["m"] })
  })

  it("does not move url to httpUrl if config has no url", () => {
    const out = GEMINI_AGENT.project(null, [
      mkServer({ name: "ghost", transport: "http", config: { headers: { K: "v" } } }),
    ]) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(out.mcpServers.ghost).toEqual({ headers: { K: "v" } })
    expect(out.mcpServers.ghost.url).toBeUndefined()
    expect(out.mcpServers.ghost.httpUrl).toBeUndefined()
  })

  it("preserves unmanaged keys; drops managed names absent from servers", () => {
    const out = GEMINI_AGENT.project(
      { mcpServers: { keep: { command: "k" }, dropMe: { command: "old" } }, otherKey: 1 },
      [],
      new Set(["dropMe"])
    ) as Record<string, unknown>
    expect(out.otherKey).toBe(1)
    const map = out.mcpServers as Record<string, unknown>
    expect(map.keep).toEqual({ command: "k" })
    expect(map.dropMe).toBeUndefined()
  })

  it("ignores mcpServers when it's not an object", () => {
    const out = GEMINI_AGENT.project({ mcpServers: "no" }, [
      mkServer({ name: "x", transport: "stdio", config: { command: "x" } }),
    ]) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(out.mcpServers)).toEqual(["x"])
  })
})
