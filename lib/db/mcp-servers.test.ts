// Coverage for the MCP server CRUD module. Uses fake-indexeddb to hit the
// Dexie store directly. We mock the lazy-imported sync module so we never
// pull Tauri IPC into jsdom.

import "fake-indexeddb/auto"

// Mock the sync module so the CRUD tests don't touch the agents pipeline.
// The mock is an ESM module (default + named export); register the named
// `scheduleSync` export so the dynamic import() in mcp-servers.ts resolves.
const scheduleSyncMock = jest.fn()
jest.mock("@/lib/claude/sync", () => ({
  __esModule: true,
  scheduleSync: scheduleSyncMock,
}))

import {
  listMcpServers,
  listEnabledMcpServers,
  listMcpServersByPlugin,
  getMcpServer,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  buildMcpServerMap,
  bulkImportMcpServers,
  parseClaudeMcpConfig,
  MCP_TRANSPORTS,
  type McpImportDraft,
} from "./mcp-servers"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"

beforeEach(async () => {
  scheduleSyncMock.mockClear()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

async function flushDynamicImport() {
  // Allow the lazy `import("@/lib/claude/sync")` promise chain to settle.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("createMcpServer", () => {
  it("creates a server with sane defaults", async () => {
    const server = await createMcpServer({
      name: "filesystem",
      transport: "stdio",
      config: { command: "npx", args: ["x"] },
    })
    expect(server.id).toMatch(/^mcp_/)
    expect(server.name).toBe("filesystem")
    expect(server.enabled).toBe(true)
    expect(server.appsEnabled).toEqual({})
    expect(server.createdAt).toBeGreaterThan(0)
    expect(server.updatedAt).toBeGreaterThan(0)

    const read = await getDb().mcpServers.get(server.id)
    expect(read?.name).toBe("filesystem")
  })

  it("respects explicit enabled=false and appsEnabled values", async () => {
    const server = await createMcpServer({
      name: "off",
      transport: "stdio",
      config: { command: "x" },
      enabled: false,
      appsEnabled: { "claude-code": true } as never,
    })
    expect(server.enabled).toBe(false)
    expect(server.appsEnabled).toEqual({ "claude-code": true })
  })

  it("falls back to 'unnamed' when name is whitespace-only", async () => {
    const server = await createMcpServer({
      name: "   ",
      transport: "stdio",
      config: {},
    })
    expect(server.name).toBe("unnamed")
  })

  // §A-6 plugin extension: an MCP server contributed by a plugin carries
  // through the optional `pluginId` so the manager can later soft-disable
  // or hard-delete just that plugin's rows. User-created rows continue to
  // omit the field entirely.
  it("preserves pluginId when supplied at create time", async () => {
    const server = await createMcpServer({
      name: "from-plugin",
      transport: "stdio",
      config: { command: "x" },
      pluginId: "cognia-git-tools",
    })
    expect(server.pluginId).toBe("cognia-git-tools")
    const read = await getDb().mcpServers.get(server.id)
    expect(read?.pluginId).toBe("cognia-git-tools")
  })

  it("omits pluginId for user-created rows (backwards compatibility)", async () => {
    const server = await createMcpServer({
      name: "user-row",
      transport: "stdio",
      config: { command: "x" },
    })
    expect(Object.prototype.hasOwnProperty.call(server, "pluginId")).toBe(false)
  })

  it("listMcpServersByPlugin returns only that plugin's rows", async () => {
    await createMcpServer({
      name: "g1",
      transport: "stdio",
      config: { command: "x" },
      pluginId: "git-tools",
    })
    await createMcpServer({
      name: "g2",
      transport: "stdio",
      config: { command: "x" },
      pluginId: "git-tools",
    })
    await createMcpServer({
      name: "s1",
      transport: "stdio",
      config: { command: "x" },
      pluginId: "shell-tools",
    })
    await createMcpServer({ name: "user-row", transport: "stdio", config: { command: "x" } })

    const owned = await listMcpServersByPlugin("git-tools")
    expect(owned.map((s) => s.name).sort()).toEqual(["g1", "g2"])
    expect(await listMcpServersByPlugin("nobody")).toEqual([])
  })

  it("schedules a sync only for agents with appsEnabled=true", async () => {
    await createMcpServer({
      name: "foo",
      transport: "stdio",
      config: {},
      appsEnabled: {
        "claude-code": true,
        vscode: false,
      } as never,
    })
    await flushDynamicImport()
    expect(scheduleSyncMock).toHaveBeenCalledWith("claude-code", undefined)
    expect(scheduleSyncMock).not.toHaveBeenCalledWith("vscode", undefined)
  })

  it("does not schedule a sync when appsEnabled is empty", async () => {
    await createMcpServer({
      name: "bare",
      transport: "stdio",
      config: {},
    })
    await flushDynamicImport()
    expect(scheduleSyncMock).not.toHaveBeenCalled()
  })
})

describe("listMcpServers / listEnabledMcpServers / getMcpServer", () => {
  it("returns servers ordered by name", async () => {
    await createMcpServer({ name: "zeta", transport: "stdio", config: {} })
    await createMcpServer({ name: "alpha", transport: "http", config: {} })
    const list = await listMcpServers()
    expect(list.map((s) => s.name)).toEqual(["alpha", "zeta"])
  })

  it("filters to only enabled servers via listEnabledMcpServers", async () => {
    await createMcpServer({ name: "on", transport: "stdio", config: {}, enabled: true })
    await createMcpServer({ name: "off", transport: "stdio", config: {}, enabled: false })
    const enabled = await listEnabledMcpServers()
    expect(enabled.map((s) => s.name)).toEqual(["on"])
  })

  it("getMcpServer returns the row by id and undefined when missing", async () => {
    const server = await createMcpServer({ name: "x", transport: "stdio", config: {} })
    expect((await getMcpServer(server.id))?.name).toBe("x")
    expect(await getMcpServer("does-not-exist")).toBeUndefined()
  })
})

describe("updateMcpServer", () => {
  it("patches fields, bumps updatedAt, and merges prior + new appsEnabled for sync", async () => {
    const server = await createMcpServer({
      name: "before",
      transport: "stdio",
      config: {},
      appsEnabled: { "claude-code": true } as never,
    })
    await flushDynamicImport()
    scheduleSyncMock.mockClear()

    // Wait one ms so updatedAt strictly increases.
    await new Promise((r) => setTimeout(r, 2))
    await updateMcpServer(server.id, {
      name: "after",
      appsEnabled: { vscode: true } as never,
    })
    await flushDynamicImport()

    const fresh = await getMcpServer(server.id)
    expect(fresh?.name).toBe("after")
    expect(fresh?.updatedAt).toBeGreaterThan(server.updatedAt)
    // Both prior (claude-code) and new (vscode) appsEnabled get a sync request.
    expect(scheduleSyncMock).toHaveBeenCalledWith("claude-code", undefined)
    expect(scheduleSyncMock).toHaveBeenCalledWith("vscode", undefined)
  })

  it("survives an update against an unknown id without scheduling", async () => {
    await updateMcpServer("does-not-exist", { name: "x" })
    await flushDynamicImport()
    expect(scheduleSyncMock).not.toHaveBeenCalled()
  })
})

describe("deleteMcpServer", () => {
  it("removes the row and tombstones the previously-projected agents", async () => {
    const server = await createMcpServer({
      name: "to-delete",
      transport: "stdio",
      config: {},
      appsEnabled: { "claude-code": true } as never,
    })
    await flushDynamicImport()
    scheduleSyncMock.mockClear()

    await deleteMcpServer(server.id)
    await flushDynamicImport()
    expect(await getMcpServer(server.id)).toBeUndefined()
    // Tombstone (the second arg is the deleted server name).
    expect(scheduleSyncMock).toHaveBeenCalledWith("claude-code", "to-delete")
  })

  it("is a no-op when the id is missing", async () => {
    await deleteMcpServer("nope")
    await flushDynamicImport()
    expect(scheduleSyncMock).not.toHaveBeenCalled()
  })
})

describe("buildMcpServerMap", () => {
  it("includes only enabled servers and folds transport into the map under `type`", async () => {
    const a = await createMcpServer({
      name: "alpha",
      transport: "stdio",
      config: { command: "x" },
    })
    const b = await createMcpServer({
      name: "beta",
      transport: "http",
      config: { url: "https://x" },
      enabled: false,
    })
    const out = buildMcpServerMap([a, b])
    expect(Object.keys(out)).toEqual(["alpha"])
    expect(out.alpha).toMatchObject({ type: "stdio", command: "x" })
  })

  it("forwards http transport with url + headers verbatim", async () => {
    const row = await createMcpServer({
      name: "wiki",
      transport: "http",
      config: { url: "https://mcp.deepwiki.com/mcp", headers: { "X-Trace": "1" } },
    })
    const out = buildMcpServerMap([row])
    expect(out.wiki).toMatchObject({
      type: "http",
      url: "https://mcp.deepwiki.com/mcp",
      headers: { "X-Trace": "1" },
    })
  })

  it("forwards sse transport with url + headers verbatim", async () => {
    const row = await createMcpServer({
      name: "stream",
      transport: "sse",
      config: { url: "https://example.com/sse", headers: { Authorization: "Bearer x" } },
    })
    const out = buildMcpServerMap([row])
    expect(out.stream).toMatchObject({
      type: "sse",
      url: "https://example.com/sse",
      headers: { Authorization: "Bearer x" },
    })
  })

  it("emits keys in sorted-name order regardless of input order", async () => {
    const z = await createMcpServer({ name: "zeta", transport: "stdio", config: { command: "z" } })
    const a = await createMcpServer({
      name: "alpha2",
      transport: "stdio",
      config: { command: "a" },
    })
    const m = await createMcpServer({ name: "mid", transport: "stdio", config: { command: "m" } })
    expect(Object.keys(buildMcpServerMap([z, m, a]))).toEqual(["alpha2", "mid", "zeta"])
    expect(Object.keys(buildMcpServerMap([a, z, m]))).toEqual(["alpha2", "mid", "zeta"])
  })
})

describe("MCP_TRANSPORTS", () => {
  it("exports the canonical transport list", () => {
    expect(MCP_TRANSPORTS).toEqual(["stdio", "sse", "http"])
  })
})

describe("bulkImportMcpServers", () => {
  function draft(name: string): McpImportDraft {
    return { name, transport: "stdio", config: { command: "x" } }
  }

  it("creates rows on first import", async () => {
    const result = await bulkImportMcpServers([draft("foo"), draft("bar")])
    expect(result.created).toBe(2)
    expect(result.updated).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.errored).toEqual([])
    const list = await listMcpServers()
    expect(list.map((s) => s.name).sort()).toEqual(["bar", "foo"])
  })

  it("skips collisions by default (case-insensitive)", async () => {
    await createMcpServer({ name: "Same", transport: "stdio", config: {} })
    const result = await bulkImportMcpServers([draft("same"), draft("fresh")])
    expect(result.skipped).toBe(1)
    expect(result.created).toBe(1)
    // Existing record retained
    expect((await listMcpServers()).find((s) => s.name === "Same")).toBeDefined()
  })

  it("overwrite strategy patches the existing record", async () => {
    await createMcpServer({
      name: "target",
      transport: "stdio",
      config: { command: "old" },
    })
    const result = await bulkImportMcpServers(
      [{ name: "target", transport: "http", config: { url: "https://x" } }],
      "overwrite"
    )
    expect(result.updated).toBe(1)
    expect(result.created).toBe(0)
    const fresh = (await listMcpServers()).find((s) => s.name === "target")
    expect(fresh?.transport).toBe("http")
    expect(fresh?.config).toMatchObject({ url: "https://x" })
  })

  it("duplicate strategy creates a new row with ' (imported)' suffix", async () => {
    await createMcpServer({
      name: "clone",
      transport: "stdio",
      config: { command: "old" },
    })
    const result = await bulkImportMcpServers(
      [{ name: "clone", transport: "stdio", config: { command: "new" } }],
      "duplicate"
    )
    expect(result.created).toBe(1)
    const names = (await listMcpServers()).map((s) => s.name).sort()
    expect(names).toContain("clone")
    expect(names).toContain("clone (imported)")
  })

  it("records errors for drafts missing a name", async () => {
    const result = await bulkImportMcpServers([{ name: "", transport: "stdio", config: {} }])
    expect(result.errored).toHaveLength(1)
    expect(result.errored[0].error).toMatch(/missing a name/i)
  })

  it("trims names before checking for collisions", async () => {
    await createMcpServer({ name: "trim", transport: "stdio", config: {} })
    const result = await bulkImportMcpServers([{ name: " trim ", transport: "stdio", config: {} }])
    expect(result.skipped).toBe(1)
    expect(result.created).toBe(0)
  })
})

describe("parseClaudeMcpConfig", () => {
  it("returns empty for null / undefined / non-objects", () => {
    expect(parseClaudeMcpConfig(null)).toEqual([])
    expect(parseClaudeMcpConfig(undefined)).toEqual([])
    expect(parseClaudeMcpConfig("foo")).toEqual([])
    expect(parseClaudeMcpConfig({})).toEqual([])
  })

  it("parses a simple stdio entry", () => {
    const drafts = parseClaudeMcpConfig({
      mcpServers: { fs: { command: "npx" } },
    })
    expect(drafts).toHaveLength(1)
    expect(drafts[0].transport).toBe("stdio")
  })
})
