// CRUD coverage for the v15 plugin tables. Each table's module mirrors the
// pattern set by `lib/db/skills.ts`, so the assertions focus on:
//   * defaults applied by `create*` / `upsert*` helpers,
//   * composite-key lookups on the three (pluginId, …) tables,
//   * cascade-delete helpers used by the plugin manager during disable /
//     uninstall.

import {
  listPlugins,
  listEnabledPlugins,
  listPluginsByCapability,
  listPluginsBySource,
  getPlugin,
  upsertPlugin,
  upsertPlugins,
  updatePlugin,
  compareAndSetPluginLifecycle,
  setPluginEnabled,
  setPluginStatus,
  setPluginError,
  setPluginConfig,
  recordPluginUsage,
  deletePlugin,
} from "./plugins"
import {
  getPermission,
  listPermissionsForPlugin,
  listAllPermissions,
  setPermission,
  revokePermission,
  revokeAllPermissionsForPlugin,
  purgeExpiredPermissions,
} from "./plugin-permissions"
import {
  getAnalytic,
  listAnalyticsForPlugin,
  incrementAnalytic,
  setAnalytic,
  clearAnalyticsForPlugin,
} from "./plugin-analytics"
import {
  listReviewsForPlugin,
  getReview,
  upsertReview,
  deleteReview,
  clearReviewsForPlugin,
  averageRatingForPlugin,
} from "./plugin-reviews"
import { createDbTestFixture } from "./test-fixture"
import type { PluginRow } from "./plugin-types"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

function makeDraft(overrides: Partial<PluginRow> = {}): Parameters<typeof upsertPlugin>[0] {
  return {
    id: "p1",
    name: "Test Plugin",
    version: "1.0.0",
    type: "frontend",
    source: "builtin",
    path: "<builtin>/p1",
    manifest: { id: "p1", name: "Test Plugin" },
    ...overrides,
  }
}

describe("plugins CRUD", () => {
  it("upsertPlugin applies defaults and stamps timestamps", async () => {
    const row = await upsertPlugin(makeDraft())
    expect(row.status).toBe("discovered")
    expect(row.enabled).toBe(false)
    expect(row.capabilities).toEqual([])
    expect(row.createdAt).toBeGreaterThan(0)
    expect(row.updatedAt).toBeGreaterThan(0)

    const read = await getPlugin("p1")
    expect(read?.name).toBe("Test Plugin")
  })

  it("upsertPlugin preserves createdAt on update and bumps updatedAt", async () => {
    const first = await upsertPlugin(makeDraft())
    await new Promise((r) => setTimeout(r, 5))
    const second = await upsertPlugin(makeDraft({ name: "Renamed" }))
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    expect(second.name).toBe("Renamed")
  })

  it("skips the write when re-discovery would change nothing", async () => {
    // Discovery re-upserts every plugin on every launch. Writing an identical
    // row wakes the /plugins live-query and resets `updatedAt`, so the Library
    // list re-rendered once per plugin at boot and "Last updated" reported the
    // last app start instead of the last real change.
    const first = await upsertPlugin(makeDraft())
    await new Promise((r) => setTimeout(r, 5))
    const second = await upsertPlugin(makeDraft())
    expect(second.updatedAt).toBe(first.updatedAt)
    expect((await getPlugin("p1"))?.updatedAt).toBe(first.updatedAt)
  })

  it("still writes when re-discovery carries a real change", async () => {
    const first = await upsertPlugin(makeDraft())
    await new Promise((r) => setTimeout(r, 5))
    const second = await upsertPlugin(makeDraft({ version: "1.1.0" }))
    expect(second.version).toBe("1.1.0")
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
  })

  it("treats a re-serialized manifest with reordered keys as unchanged", async () => {
    const first = await upsertPlugin(
      makeDraft({ manifest: { id: "p1", name: "Test Plugin", version: "1.0.0" } })
    )
    await new Promise((r) => setTimeout(r, 5))
    // The manifest is rebuilt from the module on every scan, so key order is
    // not stable. Comparing raw JSON would call every boot a change.
    const second = await upsertPlugin(
      makeDraft({ manifest: { version: "1.0.0", name: "Test Plugin", id: "p1" } })
    )
    expect(second.updatedAt).toBe(first.updatedAt)
  })

  it("still writes a manifest JSON cannot serialize", async () => {
    // IndexedDB stores by structured clone, which takes a cycle. The
    // unchanged-comparison is `JSON.stringify`, which throws on one. That
    // comparison exists to SKIP a write, so it must never be able to fail one
    // that used to go straight through.
    await upsertPlugin(makeDraft())
    const cyclic: Record<string, unknown> = { id: "p1", name: "Test Plugin" }
    cyclic.self = cyclic

    const second = await upsertPlugin(makeDraft({ manifest: cyclic, version: "1.2.0" }))

    expect(second.version).toBe("1.2.0")
    expect((await getPlugin("p1"))?.version).toBe("1.2.0")
  })

  it("upsertPlugins writes a whole discovery pass and preserves prior state", async () => {
    await upsertPlugin(makeDraft({ id: "p1", enabled: true, status: "enabled" }))
    const rows = await upsertPlugins([
      makeDraft({ id: "p1", version: "2.0.0" }),
      makeDraft({ id: "p2", name: "Second" }),
    ])
    expect(rows.map((row) => row.id)).toEqual(["p1", "p2"])
    // An upsert that omits enable state must never disable an enabled plugin.
    expect(rows[0]?.enabled).toBe(true)
    expect(rows[0]?.version).toBe("2.0.0")
    expect(await getPlugin("p2")).toBeDefined()
  })

  it("upsertPlugins leaves unchanged rows untouched", async () => {
    const first = await upsertPlugin(makeDraft())
    await new Promise((r) => setTimeout(r, 5))
    const [row] = await upsertPlugins([makeDraft()])
    expect(row?.updatedAt).toBe(first.updatedAt)
  })

  it("upsertPlugins is a no-op for an empty pass", async () => {
    await expect(upsertPlugins([])).resolves.toEqual([])
  })

  it("persists non-indexed lifecycle control-plane state without a schema migration", async () => {
    const lifecycle = {
      intent: "enabled" as const,
      actual: "active" as const,
      revision: 2,
      generation: 4,
      updatedAt: 123,
    }
    await upsertPlugin(makeDraft({ lifecycle }))

    expect(await getPlugin("p1")).toMatchObject({ lifecycle })
  })

  it("atomically rejects a stale lifecycle revision", async () => {
    await upsertPlugin(makeDraft())
    const first = {
      intent: "enabled" as const,
      actual: "activating" as const,
      revision: 1,
      updatedAt: 123,
    }
    const stale = { ...first, actual: "active" as const, revision: 2 }

    await expect(compareAndSetPluginLifecycle("p1", 0, first)).resolves.toBe(true)
    await expect(compareAndSetPluginLifecycle("p1", 0, stale)).resolves.toBe(false)
    expect((await getPlugin("p1"))?.lifecycle).toEqual(first)
  })

  it("upsertPlugin trims whitespace-only names to a fallback", async () => {
    const row = await upsertPlugin(makeDraft({ name: "   " }))
    expect(row.name).toBe("Unnamed plugin")
  })

  it("listEnabledPlugins filters by enabled flag", async () => {
    await upsertPlugin(makeDraft({ id: "a", name: "A", enabled: true }))
    await upsertPlugin(makeDraft({ id: "b", name: "B", enabled: false }))
    const enabled = await listEnabledPlugins()
    expect(enabled.map((p) => p.id)).toEqual(["a"])
  })

  it("listPluginsByCapability uses the multi-entry index", async () => {
    await upsertPlugin(makeDraft({ id: "tools", capabilities: ["tools", "commands"] }))
    await upsertPlugin(makeDraft({ id: "themes", capabilities: ["themes"] }))
    const toolsOnly = await listPluginsByCapability("tools")
    expect(toolsOnly.map((p) => p.id)).toEqual(["tools"])
  })

  it("listPluginsBySource filters by source", async () => {
    await upsertPlugin(makeDraft({ id: "b", source: "builtin" }))
    await upsertPlugin(makeDraft({ id: "m", source: "marketplace" }))
    expect((await listPluginsBySource("marketplace")).map((p) => p.id)).toEqual(["m"])
  })

  it("setPluginEnabled / setPluginStatus / setPluginError / setPluginConfig patch fields", async () => {
    await upsertPlugin(makeDraft())
    await setPluginEnabled("p1", true)
    await setPluginStatus("p1", "enabled")
    await setPluginError("p1", "boom")
    await setPluginConfig("p1", { key: "value" })
    const row = await getPlugin("p1")
    expect(row?.enabled).toBe(true)
    expect(row?.status).toBe("enabled")
    expect(row?.error).toBe("boom")
    expect(row?.config).toEqual({ key: "value" })
  })

  it("recordPluginUsage refreshes lastUsedAt", async () => {
    await upsertPlugin(makeDraft())
    expect((await getPlugin("p1"))?.lastUsedAt).toBeUndefined()
    await recordPluginUsage("p1")
    expect((await getPlugin("p1"))?.lastUsedAt).toBeGreaterThan(0)
  })

  it("deletePlugin drops the row", async () => {
    await upsertPlugin(makeDraft())
    await deletePlugin("p1")
    expect(await getPlugin("p1")).toBeUndefined()
  })

  it("listPlugins returns ordered by name", async () => {
    await upsertPlugin(makeDraft({ id: "c", name: "Charlie" }))
    await upsertPlugin(makeDraft({ id: "a", name: "Alpha" }))
    await upsertPlugin(makeDraft({ id: "b", name: "Beta" }))
    const ordered = await listPlugins()
    expect(ordered.map((p) => p.name)).toEqual(["Alpha", "Beta", "Charlie"])
  })

  it("updatePlugin merges a patch and bumps updatedAt", async () => {
    await upsertPlugin(makeDraft())
    await new Promise((r) => setTimeout(r, 5))
    await updatePlugin("p1", { version: "2.0.0" })
    const row = await getPlugin("p1")
    expect(row?.version).toBe("2.0.0")
  })
})

describe("plugin-permissions CRUD", () => {
  it("setPermission upserts and stamps grantedAt", async () => {
    const row = await setPermission({
      pluginId: "p1",
      permission: "shell:execute",
      decision: "allow",
    })
    expect(row.grantedAt).toBeGreaterThan(0)
    expect(await getPermission("p1", "shell:execute")).toMatchObject({ decision: "allow" })
  })

  it("preserves an explicit grantedAt when provided", async () => {
    const t = 1000
    const row = await setPermission({
      pluginId: "p1",
      permission: "fs:read",
      decision: "deny",
      grantedAt: t,
    })
    expect(row.grantedAt).toBe(t)
  })

  it("listPermissionsForPlugin returns only that plugin's rows", async () => {
    await setPermission({ pluginId: "p1", permission: "a", decision: "allow" })
    await setPermission({ pluginId: "p1", permission: "b", decision: "ask" })
    await setPermission({ pluginId: "p2", permission: "a", decision: "deny" })
    const rows = await listPermissionsForPlugin("p1")
    expect(rows.map((r) => r.permission).sort()).toEqual(["a", "b"])
  })

  it("listAllPermissions returns every row", async () => {
    await setPermission({ pluginId: "p1", permission: "a", decision: "allow" })
    await setPermission({ pluginId: "p2", permission: "b", decision: "deny" })
    expect((await listAllPermissions()).length).toBe(2)
  })

  it("revokePermission drops a single row", async () => {
    await setPermission({ pluginId: "p1", permission: "a", decision: "allow" })
    await revokePermission("p1", "a")
    expect(await getPermission("p1", "a")).toBeUndefined()
  })

  it("revokeAllPermissionsForPlugin returns count and clears rows", async () => {
    await setPermission({ pluginId: "p1", permission: "a", decision: "allow" })
    await setPermission({ pluginId: "p1", permission: "b", decision: "ask" })
    await setPermission({ pluginId: "p2", permission: "a", decision: "deny" })
    const removed = await revokeAllPermissionsForPlugin("p1")
    expect(removed).toBe(2)
    expect(await listPermissionsForPlugin("p1")).toEqual([])
    expect(await listPermissionsForPlugin("p2")).toHaveLength(1)
  })

  it("purgeExpiredPermissions removes only rows past expiresAt", async () => {
    await setPermission({
      pluginId: "p1",
      permission: "a",
      decision: "allow",
      expiresAt: 100,
    })
    await setPermission({ pluginId: "p1", permission: "b", decision: "allow" }) // no expiry
    await setPermission({
      pluginId: "p1",
      permission: "c",
      decision: "allow",
      expiresAt: Number.MAX_SAFE_INTEGER,
    })
    const removed = await purgeExpiredPermissions(1000)
    expect(removed).toBe(1)
    expect(await getPermission("p1", "a")).toBeUndefined()
    expect(await getPermission("p1", "b")).toBeDefined()
    expect(await getPermission("p1", "c")).toBeDefined()
  })
})

describe("plugin-analytics CRUD", () => {
  it("incrementAnalytic creates the row on first bump", async () => {
    const row = await incrementAnalytic("p1", "tool.git_status")
    expect(row.count).toBe(1)
    expect(row.lastEventAt).toBeGreaterThan(0)
  })

  it("incrementAnalytic accumulates count across bumps", async () => {
    await incrementAnalytic("p1", "tool.git_status")
    await incrementAnalytic("p1", "tool.git_status", 3)
    const row = await getAnalytic("p1", "tool.git_status")
    expect(row?.count).toBe(4)
  })

  it("setAnalytic overwrites the row", async () => {
    await setAnalytic({
      pluginId: "p1",
      key: "tool.x",
      count: 99,
      lastEventAt: 1000,
    })
    expect((await getAnalytic("p1", "tool.x"))?.count).toBe(99)
  })

  it("listAnalyticsForPlugin returns only that plugin's rows", async () => {
    await incrementAnalytic("p1", "a")
    await incrementAnalytic("p1", "b")
    await incrementAnalytic("p2", "a")
    const rows = await listAnalyticsForPlugin("p1")
    expect(rows.map((r) => r.key).sort()).toEqual(["a", "b"])
  })

  it("clearAnalyticsForPlugin returns count and drops rows", async () => {
    await incrementAnalytic("p1", "a")
    await incrementAnalytic("p1", "b")
    await incrementAnalytic("p2", "a")
    expect(await clearAnalyticsForPlugin("p1")).toBe(2)
    expect(await listAnalyticsForPlugin("p1")).toEqual([])
    expect(await listAnalyticsForPlugin("p2")).toHaveLength(1)
  })
})

describe("plugin-reviews CRUD", () => {
  const review = {
    id: "r1",
    pluginId: "p1",
    rating: 5,
    title: "Great",
    body: "Loved it",
    createdAt: 1000,
  }

  it("upsertReview / getReview round-trip", async () => {
    await upsertReview(review)
    expect(await getReview("p1", "r1")).toMatchObject({ rating: 5 })
  })

  it("listReviewsForPlugin filters by pluginId", async () => {
    await upsertReview(review)
    await upsertReview({ ...review, id: "r2", rating: 4 })
    await upsertReview({ ...review, id: "r3", pluginId: "p2", rating: 1 })
    expect((await listReviewsForPlugin("p1")).map((r) => r.id).sort()).toEqual(["r1", "r2"])
  })

  it("deleteReview removes a single row", async () => {
    await upsertReview(review)
    await deleteReview("p1", "r1")
    expect(await getReview("p1", "r1")).toBeUndefined()
  })

  it("clearReviewsForPlugin drops every row for that plugin only", async () => {
    await upsertReview(review)
    await upsertReview({ ...review, id: "r2" })
    await upsertReview({ ...review, id: "r3", pluginId: "p2" })
    expect(await clearReviewsForPlugin("p1")).toBe(2)
    expect(await listReviewsForPlugin("p1")).toEqual([])
    expect(await listReviewsForPlugin("p2")).toHaveLength(1)
  })

  it("averageRatingForPlugin returns null when no reviews exist", async () => {
    expect(await averageRatingForPlugin("p1")).toBeNull()
  })

  it("averageRatingForPlugin computes mean across reviews", async () => {
    await upsertReview({ ...review, id: "r1", rating: 5 })
    await upsertReview({ ...review, id: "r2", rating: 3 })
    const result = await averageRatingForPlugin("p1")
    expect(result?.average).toBe(4)
    expect(result?.count).toBe(2)
  })
})
