/**
 * @jest-environment node
 */
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
