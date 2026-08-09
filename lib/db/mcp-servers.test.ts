// Coverage for the MCP server CRUD module. Uses fake-indexeddb to hit the
// Dexie store directly. We mock the lazy-imported sync module so we never
// pull Tauri IPC into jsdom.

const scheduleMcpSyncDrainMock = jest.fn()
jest.mock("@/lib/mcp/sync-coordinator", () => ({
  __esModule: true,
  scheduleMcpSyncDrain: scheduleMcpSyncDrainMock,
}))

import {
  listMcpServers,
  listEnabledMcpServers,
  listMcpServersByPlugin,
  getMcpServer,
  createMcpServer,
  updateMcpServer,
  reviewMcpServer,
  deleteMcpServer,
  buildMcpServerMap,
  buildMcpServerMapResolved,
  buildMcpServerMapWithAuth,
  bulkImportMcpServers,
  parseClaudeMcpConfig,
  MCP_TRANSPORTS,
  type McpImportDraft,
} from "./mcp-servers"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  scheduleMcpSyncDrainMock.mockClear()
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

async function flushDynamicImport() {
  // Allow the lazy `import("@/lib/claude/sync")` promise chain to settle.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function createReviewed(
  partial: Parameters<typeof createMcpServer>[0]
): ReturnType<typeof createMcpServer> {
  return createMcpServer({ ...partial, trust: { state: "trusted" } })
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
    expect(server.enabled).toBe(false)
    expect(server.appsEnabled).toEqual({})
    expect(server.trust).toEqual({ state: "pending" })
    expect(server.schemaVersion).toBe(1)
    expect(server.createdAt).toBeGreaterThan(0)
    expect(server.updatedAt).toBeGreaterThan(0)

    const read = await getDb().mcpServers.get(server.id)
    expect(read?.name).toBe("filesystem")
  })

  it("honors explicit projection only for an already-reviewed definition", async () => {
    const server = await createMcpServer({
      name: "off",
      transport: "stdio",
      config: { command: "x" },
      enabled: false,
      appsEnabled: { "claude-code": true } as never,
      trust: { state: "trusted" },
    })
    expect(server.enabled).toBe(false)
    expect(server.appsEnabled).toEqual({ "claude-code": true })
  })

  it("rejects a missing namespace instead of persisting an ambiguous row", async () => {
    await expect(
      createMcpServer({ name: "   ", transport: "stdio", config: { command: "x" } })
    ).rejects.toThrow(/namespace/i)
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

  it("persists one durable sync job for each selected writable Agent", async () => {
    const server = await createMcpServer({
      name: "foo",
      transport: "stdio",
      config: { command: "x" },
      appsEnabled: {
        "claude-code": true,
        vscode: false,
      } as never,
      trust: { state: "trusted" },
    })
    await flushDynamicImport()
    expect(await getDb().mcpSyncJobs.get("claude-code")).toMatchObject({
      desiredRevision: server.revision,
      status: "pending",
    })
    expect(await getDb().mcpSyncJobs.get("vscode")).toBeUndefined()
  })

  it("does not schedule a sync when appsEnabled is empty", async () => {
    await createMcpServer({
      name: "bare",
      transport: "stdio",
      config: { command: "x" },
    })
    await flushDynamicImport()
    expect(await getDb().mcpSyncJobs.count()).toBe(0)
  })
})

describe("listMcpServers / listEnabledMcpServers / getMcpServer", () => {
  it("returns servers ordered by name", async () => {
    await createMcpServer({ name: "zeta", transport: "stdio", config: { command: "x" } })
    await createMcpServer({
      name: "alpha",
      transport: "http",
      config: { url: "https://example.com/mcp" },
    })
    const list = await listMcpServers()
    expect(list.map((s) => s.name)).toEqual(["alpha", "zeta"])
  })

  it("filters to only enabled servers via listEnabledMcpServers", async () => {
    await createReviewed({
      name: "on",
      transport: "stdio",
      config: { command: "x" },
      enabled: true,
    })
    await createMcpServer({
      name: "off",
      transport: "stdio",
      config: { command: "x" },
      enabled: false,
    })
    const enabled = await listEnabledMcpServers()
    expect(enabled.map((s) => s.name)).toEqual(["on"])
  })

  it("fails closed for enabled pending or blocked rows", async () => {
    const pending = await createMcpServer({
      name: "pending",
      transport: "stdio",
      config: { command: "x" },
    })
    await getDb().mcpServers.update(pending.id, { enabled: true })
    const blocked = await createReviewed({
      name: "blocked",
      transport: "stdio",
      config: { command: "x" },
    })
    await reviewMcpServer(blocked.id, false)
    await getDb().mcpServers.update(blocked.id, { enabled: true })
    expect(await listEnabledMcpServers()).toEqual([])
  })

  it("getMcpServer returns the row by id and undefined when missing", async () => {
    const server = await createMcpServer({
      name: "x",
      transport: "stdio",
      config: { command: "x" },
    })
    expect((await getMcpServer(server.id))?.name).toBe("x")
    expect(await getMcpServer("does-not-exist")).toBeUndefined()
  })
})

describe("updateMcpServer", () => {
  it("patches fields, bumps updatedAt, and merges prior + new appsEnabled for sync", async () => {
    const server = await createMcpServer({
      name: "before",
      transport: "stdio",
      config: { command: "x" },
      appsEnabled: { "claude-code": true } as never,
      trust: { state: "trusted" },
    })
    await flushDynamicImport()
    await getDb().mcpSyncJobs.clear()

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
    expect(fresh).toMatchObject({ enabled: false, revision: 2, trust: { state: "pending" } })
    expect(await getDb().mcpSyncJobs.get("claude-code")).toMatchObject({
      tombstones: ["before"],
    })
    expect(await getDb().mcpSyncJobs.get("vscode")).toMatchObject({ tombstones: ["before"] })
  })

  it("survives an update against an unknown id without scheduling", async () => {
    await updateMcpServer("does-not-exist", { name: "x" })
    await flushDynamicImport()
    expect(await getDb().mcpSyncJobs.count()).toBe(0)
  })
})

describe("deleteMcpServer", () => {
  it("removes the row and tombstones the previously-projected agents", async () => {
    const server = await createMcpServer({
      name: "to-delete",
      transport: "stdio",
      config: { command: "x" },
      appsEnabled: { "claude-code": true } as never,
      trust: { state: "trusted" },
    })
    await flushDynamicImport()
    await getDb().mcpSyncJobs.clear()

    await deleteMcpServer(server.id)
    await flushDynamicImport()
    expect(await getMcpServer(server.id)).toBeUndefined()
    expect(await getDb().mcpServerSummaries.get(server.id)).toBeUndefined()
    expect(await getDb().mcpSyncJobs.get("claude-code")).toMatchObject({
      tombstones: ["to-delete"],
    })
  })

  it("is a no-op when the id is missing", async () => {
    await deleteMcpServer("nope")
    await flushDynamicImport()
    expect(await getDb().mcpSyncJobs.count()).toBe(0)
  })
})

describe("buildMcpServerMap", () => {
  it("includes only enabled servers and folds transport into the map under `type`", async () => {
    const a = await createReviewed({
      name: "alpha",
      transport: "stdio",
      config: { command: "x" },
    })
    const b = await createReviewed({
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
    const row = await createReviewed({
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

  it("applies the remote egress guard before projecting into an SDK session", async () => {
    const blocked = await createReviewed({
      name: "blocked-local",
      transport: "http",
      config: { url: "https://127.0.0.1/mcp" },
    })
    expect(() => buildMcpServerMap([blocked])).toThrow("private")

    const reviewed = {
      ...blocked,
      config: { url: "http://127.0.0.1/mcp", allowPrivateNetwork: true },
    }
    expect(buildMcpServerMap([reviewed])["blocked-local"]).toMatchObject({
      url: "http://127.0.0.1/mcp",
      allowPrivateNetwork: true,
    })
  })

  it("never returns a newly persisted authorization header as plaintext", async () => {
    const row = await createReviewed({
      name: "stream",
      transport: "sse",
      config: { url: "https://example.com/sse", headers: { Authorization: "Bearer x" } },
    })
    const out = buildMcpServerMap([row])
    expect(out.stream).toMatchObject({
      type: "sse",
      url: "https://example.com/sse",
      headers: {
        Authorization: { secretRef: expect.stringMatching(/\/headers\/Authorization$/) },
      },
    })
  })

  it("emits keys in sorted-name order regardless of input order", async () => {
    const z = await createReviewed({ name: "zeta", transport: "stdio", config: { command: "z" } })
    const a = await createReviewed({
      name: "alpha2",
      transport: "stdio",
      config: { command: "a" },
    })
    const m = await createReviewed({ name: "mid", transport: "stdio", config: { command: "m" } })
    expect(Object.keys(buildMcpServerMap([z, m, a]))).toEqual(["alpha2", "mid", "zeta"])
    expect(Object.keys(buildMcpServerMap([a, z, m]))).toEqual(["alpha2", "mid", "zeta"])
  })

  it("resolves SecretRef values before projecting outside the Tauri auth path", async () => {
    const row = await createReviewed({
      name: "secret-cli",
      transport: "stdio",
      config: { command: "tool", args: ["--token", { secretRef: "mcp/secret-cli/args/1" }] },
    })

    const out = await buildMcpServerMapResolved([row], async () => ({
      command: "tool",
      args: ["--token", "resolved-secret"],
    }))

    expect(out["secret-cli"]).toEqual({
      type: "stdio",
      command: "tool",
      args: ["--token", "resolved-secret"],
    })
  })
})

describe("buildMcpServerMapWithAuth", () => {
  it("injects a bearer header for a remote server with a stored token", async () => {
    const row = await createReviewed({
      name: "remote",
      transport: "http",
      config: { url: "https://x/mcp" },
    })
    const out = await buildMcpServerMapWithAuth([row], {
      loadEntry: async () => ({ accessToken: "tok-123" }),
    })
    expect(out.remote).toMatchObject({
      type: "http",
      url: "https://x/mcp",
      headers: { Authorization: "Bearer tok-123" },
    })
  })

  it("merges the bearer header alongside existing static headers", async () => {
    const row = await createReviewed({
      name: "remote",
      transport: "sse",
      config: { url: "https://x/sse", headers: { "X-Trace": "1" } },
    })
    const out = await buildMcpServerMapWithAuth([row], {
      loadEntry: async () => ({ accessToken: "abc" }),
    })
    expect(out.remote.headers).toEqual({ "X-Trace": "1", Authorization: "Bearer abc" })
  })

  it("leaves stdio servers and tokenless remotes untouched", async () => {
    const stdio = await createReviewed({
      name: "alpha",
      transport: "stdio",
      config: { command: "x" },
    })
    const remote = await createReviewed({
      name: "beta",
      transport: "http",
      config: { url: "https://y" },
    })
    const out = await buildMcpServerMapWithAuth([stdio, remote], {
      loadEntry: async () => undefined,
    })
    expect(out.alpha).not.toHaveProperty("headers")
    expect(out.beta).not.toHaveProperty("headers")
  })

  it("refreshes a near-expiry token before injecting it", async () => {
    const row = await createReviewed({
      name: "remote",
      transport: "http",
      config: { url: "https://x" },
    })
    const refresh = jest.fn(async () => ({ accessToken: "fresh", expiresAtMs: 10_000 }))
    const out = await buildMcpServerMapWithAuth([row], {
      loadEntry: async () => ({ accessToken: "stale", expiresAtMs: 1_000 }),
      refresh,
      now: () => 900, // 1000 - 900 = 100ms left < 60s skew
    })
    expect(refresh).toHaveBeenCalledWith("remote")
    expect(out.remote.headers).toEqual({ Authorization: "Bearer fresh" })
  })

  it("does not refresh a token that is comfortably valid", async () => {
    const row = await createReviewed({
      name: "remote",
      transport: "http",
      config: { url: "https://x" },
    })
    const refresh = jest.fn()
    const out = await buildMcpServerMapWithAuth([row], {
      loadEntry: async () => ({ accessToken: "ok", expiresAtMs: 10_000_000 }),
      refresh,
      now: () => 0,
    })
    expect(refresh).not.toHaveBeenCalled()
    expect(out.remote.headers).toEqual({ Authorization: "Bearer ok" })
  })

  it("falls back to the un-authed config when the auth lookup throws", async () => {
    const row = await createReviewed({
      name: "remote",
      transport: "http",
      config: { url: "https://x" },
    })
    const out = await buildMcpServerMapWithAuth([row], {
      loadEntry: async () => {
        throw new Error("keyring unavailable")
      },
    })
    expect(out.remote).not.toHaveProperty("headers")
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
    await createMcpServer({ name: "Same", transport: "stdio", config: { command: "x" } })
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

  it("duplicate strategy creates a new row with a valid imported suffix", async () => {
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
    expect(names).toContain("clone-imported")
  })

  it("records errors for drafts missing a name", async () => {
    const result = await bulkImportMcpServers([
      { name: "", transport: "stdio", config: { command: "x" } },
    ])
    expect(result.errored).toHaveLength(1)
    expect(result.errored[0].error).toMatch(/missing a name/i)
  })

  it("trims names before checking for collisions", async () => {
    await createMcpServer({ name: "trim", transport: "stdio", config: { command: "x" } })
    const result = await bulkImportMcpServers([
      { name: " trim ", transport: "stdio", config: { command: "x" } },
    ])
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
