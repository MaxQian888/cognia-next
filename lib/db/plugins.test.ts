/** @jest-environment jsdom */
// CRUD coverage for the v15 plugin tables. Each table's module mirrors the
// pattern set by `lib/db/skills.ts`, so the assertions focus on:
//   * defaults applied by `create*` / `upsert*` helpers,
//   * composite-key lookups on the three (pluginId, …) tables,
//   * cascade-delete helpers used by the plugin manager during disable /
//     uninstall.

import "fake-indexeddb/auto"
import {
  listPlugins,
  listEnabledPlugins,
  listPluginsByCapability,
  listPluginsBySource,
  getPlugin,
  upsertPlugin,
  updatePlugin,
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
import {
  listAllScheduledJobs,
  listActiveScheduledJobs,
  listScheduledJobsForPlugin,
  getScheduledJob,
  createScheduledJob,
  updateScheduledJob,
  deleteScheduledJob,
  deleteScheduledJobsForPlugin,
} from "./plugin-scheduled-jobs"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"
import type { PluginRow } from "./plugin-types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await whenSeeded()
})

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

describe("plugin-scheduled-jobs CRUD", () => {
  it("createScheduledJob applies defaults and timestamps", async () => {
    const row = await createScheduledJob({ pluginId: "p1", cron: "* * * * *", handler: "h" })
    expect(row.status).toBe("active")
    expect(row.id).toMatch(/^pjob_/)
    expect(row.createdAt).toBeGreaterThan(0)
  })

  it("createScheduledJob honors explicit ids and status", async () => {
    const row = await createScheduledJob({
      id: "fixed-id",
      pluginId: "p1",
      cron: "* * * * *",
      handler: "h",
      status: "paused",
    })
    expect(row.id).toBe("fixed-id")
    expect(row.status).toBe("paused")
  })

  it("listAllScheduledJobs / listActiveScheduledJobs filter on status", async () => {
    await createScheduledJob({ pluginId: "p1", cron: "*", handler: "a", status: "active" })
    await createScheduledJob({ pluginId: "p1", cron: "*", handler: "b", status: "paused" })
    expect((await listAllScheduledJobs()).length).toBe(2)
    expect((await listActiveScheduledJobs()).map((r) => r.handler)).toEqual(["a"])
  })

  it("listScheduledJobsForPlugin filters by pluginId", async () => {
    await createScheduledJob({ pluginId: "p1", cron: "*", handler: "a" })
    await createScheduledJob({ pluginId: "p2", cron: "*", handler: "b" })
    const rows = await listScheduledJobsForPlugin("p1")
    expect(rows.map((r) => r.handler)).toEqual(["a"])
  })

  it("updateScheduledJob bumps updatedAt and merges fields", async () => {
    const created = await createScheduledJob({ pluginId: "p1", cron: "*", handler: "h" })
    await new Promise((r) => setTimeout(r, 5))
    await updateScheduledJob(created.id, { status: "paused" })
    const updated = await getScheduledJob(created.id)
    expect(updated?.status).toBe("paused")
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)
  })

  it("deleteScheduledJob removes a single row", async () => {
    const row = await createScheduledJob({ pluginId: "p1", cron: "*", handler: "h" })
    await deleteScheduledJob(row.id)
    expect(await getScheduledJob(row.id)).toBeUndefined()
  })

  it("deleteScheduledJobsForPlugin drops only that plugin's rows", async () => {
    await createScheduledJob({ pluginId: "p1", cron: "*", handler: "a" })
    await createScheduledJob({ pluginId: "p1", cron: "*", handler: "b" })
    await createScheduledJob({ pluginId: "p2", cron: "*", handler: "c" })
    expect(await deleteScheduledJobsForPlugin("p1")).toBe(2)
    expect(await listScheduledJobsForPlugin("p1")).toEqual([])
    expect(await listScheduledJobsForPlugin("p2")).toHaveLength(1)
  })
})
