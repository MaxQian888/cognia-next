import type { McpServer } from "@cognia/agent-config-types"

import { OPENCODE_AGENT } from "./opencode"

function mkServer(
  partial: Pick<McpServer, "name" | "transport" | "config"> & { enabled?: boolean }
): McpServer {
  return {
    id: `mcp_${partial.name}`,
    enabled: true,
    appsEnabled: {},
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  }
}

describe("opencode adapter — metadata", () => {
  it("is a writable JSON adapter", () => {
    expect(OPENCODE_AGENT.id).toBe("opencode")
    expect(OPENCODE_AGENT.writable).toBe(true)
    expect(OPENCODE_AGENT.format).toBe("json")
  })
})

describe("opencode adapter — parse", () => {
  it("returns [] for null / non-object input", () => {
    expect(OPENCODE_AGENT.parse(null)).toEqual([])
    expect(OPENCODE_AGENT.parse("x")).toEqual([])
    expect(OPENCODE_AGENT.parse([])).toEqual([])
  })

  it("returns [] when mcp is missing or non-object", () => {
    expect(OPENCODE_AGENT.parse({})).toEqual([])
    expect(OPENCODE_AGENT.parse({ mcp: "x" })).toEqual([])
  })

  it("splits the flattened command array back into command + args", () => {
    const drafts = OPENCODE_AGENT.parse({
      mcp: {
        pencil: {
          type: "local",
          command: ["npx", "-y", "pkg"],
          enabled: true,
          environment: { API_KEY: "k" },
        },
      },
    })
    expect(drafts).toEqual([
      {
        name: "pencil",
        transport: "stdio",
        config: { command: "npx", args: ["-y", "pkg"], env: { API_KEY: "k" } },
      },
    ])
  })

  it("handles a single-element command array with no args", () => {
    const drafts = OPENCODE_AGENT.parse({
      mcp: { solo: { type: "local", command: ["mybin"] } },
    })
    expect(drafts[0].config).toEqual({ command: "mybin" })
  })

  it("maps remote entries to http", () => {
    const drafts = OPENCODE_AGENT.parse({
      mcp: {
        api: { type: "remote", url: "https://x/mcp", headers: { Authorization: "Bearer t" } },
      },
    })
    expect(drafts[0].transport).toBe("http")
    expect(drafts[0].config).toEqual({
      url: "https://x/mcp",
      headers: { Authorization: "Bearer t" },
    })
  })

  it("drops entries with an empty or non-array command", () => {
    const drafts = OPENCODE_AGENT.parse({
      mcp: {
        bad: { type: "local", command: [] },
        alsoBad: { type: "local", command: "npx" },
        worse: { type: "remote" },
      },
    })
    expect(drafts).toEqual([])
  })
})

describe("opencode adapter — project", () => {
  it("flattens command + args into one array", () => {
    const out = OPENCODE_AGENT.project(null, [
      mkServer({
        name: "fs",
        transport: "stdio",
        config: { command: "npx", args: ["-y", "pkg"], env: { K: "v" } },
      }),
    ]) as { mcp: Record<string, Record<string, unknown>> }
    expect(out.mcp.fs).toEqual({
      type: "local",
      command: ["npx", "-y", "pkg"],
      enabled: true,
      environment: { K: "v" },
    })
  })

  it("omits environment when there are no env vars", () => {
    const out = OPENCODE_AGENT.project(null, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as { mcp: Record<string, Record<string, unknown>> }
    expect(out.mcp.fs).toEqual({ type: "local", command: ["npx"], enabled: true })
  })

  it("writes remote servers with type remote", () => {
    const out = OPENCODE_AGENT.project(null, [
      mkServer({ name: "api", transport: "http", config: { url: "https://x" } }),
    ]) as { mcp: Record<string, Record<string, unknown>> }
    expect(out.mcp.api).toEqual({ type: "remote", url: "https://x", enabled: true })
  })

  it("carries headers onto a remote server", () => {
    const out = OPENCODE_AGENT.project(null, [
      mkServer({
        name: "api",
        transport: "http",
        config: { url: "https://x", headers: { Authorization: "Bearer t" } },
      }),
    ]) as { mcp: Record<string, Record<string, unknown>> }
    expect(out.mcp.api).toEqual({
      type: "remote",
      url: "https://x",
      enabled: true,
      headers: { Authorization: "Bearer t" },
    })
  })

  it("omits an empty headers map", () => {
    const out = OPENCODE_AGENT.project(null, [
      mkServer({ name: "api", transport: "http", config: { url: "https://x", headers: {} } }),
    ]) as { mcp: Record<string, Record<string, unknown>> }
    expect(out.mcp.api).not.toHaveProperty("headers")
  })

  it("falls back to an empty url when config has none", () => {
    const out = OPENCODE_AGENT.project(null, [
      mkServer({ name: "api", transport: "http", config: {} }),
    ]) as { mcp: Record<string, Record<string, unknown>> }
    expect(out.mcp.api.url).toBe("")
  })

  it("falls back to an empty command when a stdio config has none", () => {
    const out = OPENCODE_AGENT.project(null, [
      mkServer({ name: "b", transport: "stdio", config: {} }),
    ]) as { mcp: Record<string, Record<string, unknown>> }
    expect(out.mcp.b.command).toEqual([""])
  })

  it("maps sse to opencode's single remote kind", () => {
    const out = OPENCODE_AGENT.project(null, [
      mkServer({ name: "s", transport: "sse", config: { url: "https://x/sse" } }),
    ]) as { mcp: Record<string, Record<string, unknown>> }
    expect(out.mcp.s.type).toBe("remote")
  })

  it("honours the server's enabled toggle", () => {
    const out = OPENCODE_AGENT.project(null, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" }, enabled: false }),
    ]) as { mcp: Record<string, Record<string, unknown>> }
    expect(out.mcp.fs.enabled).toBe(false)
  })

  it("preserves unmanaged root keys and servers", () => {
    const out = OPENCODE_AGENT.project(
      { plugin: ["a"], mcp: { keep: { type: "local", command: ["k"] } } },
      [mkServer({ name: "new", transport: "stdio", config: { command: "n" } })]
    ) as Record<string, unknown>
    expect(out.plugin).toEqual(["a"])
    expect((out.mcp as Record<string, unknown>).keep).toEqual({ type: "local", command: ["k"] })
  })

  it("drops a managed name on flush", () => {
    const out = OPENCODE_AGENT.project(
      { mcp: { fs: { type: "local", command: ["old"] }, x: { type: "local", command: ["x"] } } },
      [],
      new Set(["fs"])
    ) as { mcp: Record<string, unknown> }
    expect(out.mcp.fs).toBeUndefined()
    expect(out.mcp.x).toEqual({ type: "local", command: ["x"] })
  })

  it("round-trips a server through project then parse", () => {
    const server = mkServer({
      name: "rt",
      transport: "stdio",
      config: { command: "npx", args: ["-y", "pkg"], env: { A: "1" } },
    })
    const projected = OPENCODE_AGENT.project(null, [server])
    const drafts = OPENCODE_AGENT.parse(projected)
    expect(drafts).toEqual([{ name: "rt", transport: "stdio", config: server.config }])
  })
})
