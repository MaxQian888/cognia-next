import type { McpServer } from "@cognia/agent-config-types"

import { ZED_AGENT } from "./zed"

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

describe("zed adapter — metadata", () => {
  it("is a writable JSONC adapter", () => {
    expect(ZED_AGENT.id).toBe("zed")
    expect(ZED_AGENT.writable).toBe(true)
    expect(ZED_AGENT.format).toBe("jsonc")
  })
})

describe("zed adapter — parse", () => {
  it("returns [] for null / non-object input", () => {
    expect(ZED_AGENT.parse(null)).toEqual([])
    expect(ZED_AGENT.parse("x")).toEqual([])
    expect(ZED_AGENT.parse([])).toEqual([])
  })

  it("returns [] when context_servers is missing or non-object", () => {
    expect(ZED_AGENT.parse({})).toEqual([])
    expect(ZED_AGENT.parse({ context_servers: "x" })).toEqual([])
  })

  it("infers transport structurally — Zed's enum is untagged", () => {
    const drafts = ZED_AGENT.parse({
      context_servers: {
        local: { enabled: true, command: "npx", args: ["-y", "pkg"] },
        api: { enabled: true, url: "https://x/mcp" },
        broken: { random: "thing" },
      },
    })
    const byName = Object.fromEntries(drafts.map((d) => [d.name, d]))
    expect(byName.local.transport).toBe("stdio")
    expect(byName.local.config).toEqual({ command: "npx", args: ["-y", "pkg"] })
    expect(byName.api.transport).toBe("http")
    expect(byName.broken).toBeUndefined()
  })

  it("skips extension-provided servers, which we cannot represent", () => {
    const drafts = ZED_AGENT.parse({
      context_servers: {
        someExt: { enabled: true, settings: { apiKey: "x" } },
        mine: { command: "npx" },
      },
    })
    expect(drafts.map((d) => d.name)).toEqual(["mine"])
  })
})

describe("zed adapter — project", () => {
  it("writes a stdio server with a flat command and no type key", () => {
    const out = ZED_AGENT.project(null, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx", args: ["-y"] } }),
    ]) as { context_servers: Record<string, Record<string, unknown>> }
    expect(out.context_servers.fs).toEqual({ enabled: true, command: "npx", args: ["-y"] })
  })

  it("writes a remote server as url + enabled", () => {
    const out = ZED_AGENT.project(null, [
      mkServer({ name: "api", transport: "http", config: { url: "https://x" } }),
    ]) as { context_servers: Record<string, Record<string, unknown>> }
    expect(out.context_servers.api).toEqual({ enabled: true, url: "https://x" })
  })

  it("honours the server's own enabled toggle", () => {
    const out = ZED_AGENT.project(null, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" }, enabled: false }),
    ]) as { context_servers: Record<string, Record<string, unknown>> }
    expect(out.context_servers.fs.enabled).toBe(false)
  })

  it("preserves unrelated settings.json keys", () => {
    const out = ZED_AGENT.project({ buffer_font_size: 15, context_servers: {} }, [
      mkServer({ name: "fs", transport: "stdio", config: { command: "npx" } }),
    ]) as Record<string, unknown>
    expect(out.buffer_font_size).toBe(15)
  })

  it("never overwrites an extension server, even on a name collision", () => {
    const out = ZED_AGENT.project(
      { context_servers: { shared: { enabled: true, settings: { k: 1 } } } },
      [mkServer({ name: "shared", transport: "stdio", config: { command: "npx" } })]
    ) as { context_servers: Record<string, Record<string, unknown>> }
    expect(out.context_servers.shared).toEqual({ enabled: true, settings: { k: 1 } })
  })

  it("drops a managed name on flush but keeps unmanaged ones", () => {
    const out = ZED_AGENT.project(
      { context_servers: { fs: { command: "old" }, x: { command: "x" } } },
      [],
      new Set(["fs"])
    ) as { context_servers: Record<string, unknown> }
    expect(out.context_servers.fs).toBeUndefined()
    expect(out.context_servers.x).toEqual({ command: "x" })
  })
})
