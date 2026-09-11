/**
 * @jest-environment node
 */
import type { McpServer } from "@cognia/agent-config-types"
import { createMcpProbeCache, toCacheEntry } from "./mcp-cache"
import type { McpToolInfo } from "../../mcp/probe-mcp-tools"

describe("createMcpProbeCache", () => {
  it("stores, reads, and reports presence", () => {
    const cache = createMcpProbeCache()
    expect(cache.has("fs")).toBe(false)
    expect(cache.get("fs")).toBeUndefined()
    const entry = toCacheEntry(
      { status: "connected", tools: [{ name: "t" }], resources: [], prompts: [] },
      100
    )
    cache.set("fs", entry)
    expect(cache.has("fs")).toBe(true)
    expect(cache.get("fs")).toEqual(entry)
  })

  it("clears one entry by name and the whole cache when name is omitted", () => {
    const cache = createMcpProbeCache()
    const e = toCacheEntry({ status: "connected", tools: [], resources: [], prompts: [] }, 1)
    cache.set("a", e)
    cache.set("b", e)
    cache.clear("a")
    expect(cache.has("a")).toBe(false)
    expect(cache.has("b")).toBe(true)
    cache.clear()
    expect(cache.has("b")).toBe(false)
  })

  it("two caches are isolated (no shared module state)", () => {
    const c1 = createMcpProbeCache()
    const c2 = createMcpProbeCache()
    c1.set("x", toCacheEntry({ status: "failed", tools: [], resources: [], prompts: [] }, 0))
    expect(c2.has("x")).toBe(false)
  })
})

describe("probe cache identity and freshness", () => {
  const server: McpServer = {
    id: "server-id",
    name: "remote",
    transport: "http",
    config: { url: "https://example.com/mcp", headers: { Authorization: "secret" } },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const entry = toCacheEntry(
    { status: "connected", tools: [{ name: "old" }], resources: [], prompts: [] },
    0
  )

  it.each([
    { config: { url: "https://other.example.com/mcp" } },
    { config: { ...server.config, headers: { Authorization: "rotated" } } },
    { config: { ...server.config, env: { TOKEN: "rotated" } } },
    { config: { ...server.config, headers: { Authorization: { secretRef: "other-secret" } } } },
    { id: "replacement-id" },
    { enabled: false },
    { transport: "sse" },
    { revision: 2 },
    { credentialVersion: 2 },
  ] as Partial<McpServer>[])("does not reuse results for changed connection %j", (change) => {
    const cache = createMcpProbeCache()
    cache.set(server.name, entry, server)
    expect(cache.get(server.name, server)).toBe(entry)
    expect(cache.get(server.name, { ...server, ...change })).toBeUndefined()
    expect(cache.has(server.name, { ...server, ...change })).toBe(false)
  })

  it("normalizes object order but keeps argument order meaningful", () => {
    const cache = createMcpProbeCache()
    const first: McpServer = {
      ...server,
      transport: "stdio",
      config: {
        command: "node",
        args: ["a", "b"],
        env: { A: "one", B: "two" },
      },
    }
    cache.set(first.name, entry, first)
    const reordered: McpServer = {
      ...first,
      config: {
        env: { B: "two", A: "one" },
        args: ["a", "b"],
        command: "node",
      },
    }
    expect(cache.get(first.name, reordered)).toBe(entry)
    expect(
      cache.get(first.name, { ...first, config: { ...first.config, args: ["b", "a"] } })
    ).toBeUndefined()
  })

  it("does not trust legacy name-only results for an identified server", () => {
    const cache = createMcpProbeCache()
    cache.set(server.name, entry)
    expect(cache.get(server.name)).toBe(entry)
    expect(cache.get(server.name, server)).toBeUndefined()
    cache.set(server.name, entry, server)
    expect(cache.get(server.name, server)).toBe(entry)
  })

  it("expires successful results after 60 seconds and refreshes their lifetime on set", () => {
    let clock = 100
    const cache = createMcpProbeCache({ now: () => clock })
    cache.set(server.name, entry, server)
    clock += 59_999
    expect(cache.has(server.name, server)).toBe(true)
    clock += 1
    expect(cache.get(server.name, server)).toBeUndefined()
    expect(cache.has(server.name)).toBe(false)
    cache.set(server.name, entry, server)
    expect(cache.get(server.name, server)).toBe(entry)
  })

  it("supports custom expiry and invalidates results if the clock moves backwards", () => {
    let clock = 100
    const cache = createMcpProbeCache({ now: () => clock, ttlMs: 10 })
    cache.set(server.name, entry, server)
    clock = 110
    expect(cache.has(server.name, server)).toBe(false)
    cache.set(server.name, entry, server)
    clock = 109
    expect(cache.has(server.name, server)).toBe(false)
  })
})

describe("toCacheEntry", () => {
  it("derives toolCount and stamps probedAt", () => {
    const tools: McpToolInfo[] = [{ name: "a" }, { name: "b" }]
    const entry = toCacheEntry({ status: "connected", tools, resources: [], prompts: [] }, 42)
    expect(entry.toolCount).toBe(2)
    expect(entry.probedAt).toBe(42)
    expect(entry.error).toBeUndefined()
  })

  it("keeps the error only when present", () => {
    const withErr = toCacheEntry(
      { status: "failed", tools: [], resources: [], prompts: [], error: "boom" },
      0
    )
    expect(withErr.error).toBe("boom")
    expect(withErr.toolCount).toBe(0)
  })
})
