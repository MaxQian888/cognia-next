/**
 * @jest-environment node
 */

import "fake-indexeddb/auto"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { syncWikiCronToScheduler, resolveCronExpression, WIKI_REBUILD_TASK_ID } from "./cron-bridge"

beforeEach(async () => {
  await schedulerDb.delete()
  await schedulerDb.open()
})

describe("resolveCronExpression", () => {
  it("returns null for off mode", () => {
    expect(resolveCronExpression({ mode: "off" })).toBeNull()
  })

  it("returns the daily preset for daily mode", () => {
    expect(resolveCronExpression({ mode: "daily" })).toBe("0 3 * * *")
  })

  it("returns the weekly preset for weekly mode", () => {
    expect(resolveCronExpression({ mode: "weekly" })).toBe("0 3 * * 0")
  })

  it("returns the custom cron when valid", () => {
    expect(resolveCronExpression({ mode: "custom", customCron: "*/15 * * * *" })).toBe(
      "*/15 * * * *"
    )
  })

  it("returns null for custom with no expression", () => {
    expect(resolveCronExpression({ mode: "custom" })).toBeNull()
  })

  it("returns null for custom with invalid expression", () => {
    expect(resolveCronExpression({ mode: "custom", customCron: "not-a-cron" })).toBeNull()
  })
})

describe("syncWikiCronToScheduler", () => {
  it("returns skipped when schedule is undefined and no row exists", async () => {
    const r = await syncWikiCronToScheduler(undefined)
    expect(r.action).toBe("skipped")
    expect(await schedulerDb.getTask(WIKI_REBUILD_TASK_ID)).toBeNull()
  })

  it("creates a daily task on first save", async () => {
    const r = await syncWikiCronToScheduler({ mode: "daily" })
    expect(r.action).toBe("created")
    const row = await schedulerDb.getTask(WIKI_REBUILD_TASK_ID)
    expect(row).not.toBeNull()
    expect(row!.type).toBe("wiki-rebuild")
    expect(row!.trigger.type).toBe("cron")
    expect(row!.trigger.type === "cron" && row!.trigger.cronExpression).toBe("0 3 * * *")
    expect(row!.payload?.force).toBe(false)
  })

  it("updates an existing row when the mode flips", async () => {
    await syncWikiCronToScheduler({ mode: "daily" })
    const r = await syncWikiCronToScheduler({ mode: "weekly" })
    expect(r.action).toBe("updated")
    const row = await schedulerDb.getTask(WIKI_REBUILD_TASK_ID)
    expect(row!.trigger.type === "cron" && row!.trigger.cronExpression).toBe("0 3 * * 0")
  })

  it("persists force=true in the payload", async () => {
    await syncWikiCronToScheduler({ mode: "weekly", force: true })
    const row = await schedulerDb.getTask(WIKI_REBUILD_TASK_ID)
    expect(row!.payload?.force).toBe(true)
  })

  it("deletes the row when the schedule turns off", async () => {
    await syncWikiCronToScheduler({ mode: "daily" })
    const r = await syncWikiCronToScheduler({ mode: "off" })
    expect(r.action).toBe("deleted")
    expect(await schedulerDb.getTask(WIKI_REBUILD_TASK_ID)).toBeNull()
  })

  it("surfaces invalid custom expressions without modifying existing rows", async () => {
    await syncWikiCronToScheduler({ mode: "daily" })
    const r = await syncWikiCronToScheduler({ mode: "custom", customCron: "not-a-cron" })
    expect(r.action).toBe("invalid")
    expect(r.invalidExpression).toBe("not-a-cron")
    // Previous daily row is preserved — invalid input must not silently drop work.
    const row = await schedulerDb.getTask(WIKI_REBUILD_TASK_ID)
    expect(row!.trigger.type === "cron" && row!.trigger.cronExpression).toBe("0 3 * * *")
  })

  it("accepts a valid custom expression", async () => {
    const r = await syncWikiCronToScheduler({ mode: "custom", customCron: "*/30 * * * *" })
    expect(r.action).toBe("created")
    const row = await schedulerDb.getTask(WIKI_REBUILD_TASK_ID)
    expect(row!.trigger.type === "cron" && row!.trigger.cronExpression).toBe("*/30 * * * *")
  })

  it("propagates the timezone field", async () => {
    await syncWikiCronToScheduler({ mode: "daily", timezone: "Asia/Shanghai" })
    const row = await schedulerDb.getTask(WIKI_REBUILD_TASK_ID)
    expect(row!.trigger.type === "cron" && row!.trigger.timezone).toBe("Asia/Shanghai")
  })
})
