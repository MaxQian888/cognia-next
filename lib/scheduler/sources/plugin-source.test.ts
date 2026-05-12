import {
  createPluginSource,
  toUnifiedPluginJob,
  PluginSourceWriteNotSupportedError,
} from "./plugin-source"
import type { PluginScheduledJobRow } from "@/lib/db/plugin-types"

function makeJob(overrides: Partial<PluginScheduledJobRow> = {}): PluginScheduledJobRow {
  return {
    id: "job-1",
    pluginId: "plugin-x",
    cron: "0 * * * *",
    handler: "hourlyTick",
    args: {},
    status: "active",
    nextRunAt: 1_700_000_000_000,
    lastRunAt: 1_699_000_000_000,
    createdAt: 1_698_000_000_000,
    updatedAt: 1_698_000_000_000,
    ...overrides,
  }
}

describe("toUnifiedPluginJob", () => {
  it("maps a plugin job to the unified shape", () => {
    const u = toUnifiedPluginJob(makeJob())
    expect(u.unifiedId).toBe("plugin:job-1")
    expect(u.kind).toBe("plugin")
    expect(u.name).toBe("plugin-x · hourlyTick")
    expect(u.status).toBe("active")
    expect(u.triggerSummary).toEqual({ type: "cron", cron: "0 * * * *" })
    expect(u.nextRunAt).toBe(1_700_000_000_000)
    expect(u.capabilities).toEqual({
      runNow: false,
      pause: true,
      edit: true,
      delete: true,
    })
    expect(u.origin.deepLinkHref).toContain("plugins")
    expect(u.origin.deepLinkHref).toContain("plugin-x")
  })

  it("collapses 'error' status to 'disabled'", () => {
    expect(toUnifiedPluginJob(makeJob({ status: "error" })).status).toBe("disabled")
  })

  it("returns 'unknown' for unrecognized statuses", () => {
    expect(toUnifiedPluginJob(makeJob({ status: "wat" })).status).toBe("unknown")
  })
})

describe("createPluginSource", () => {
  function makeStubs(initial: PluginScheduledJobRow[] = [makeJob()]) {
    let jobs: PluginScheduledJobRow[] = [...initial]
    const db = {
      pluginScheduledJobs: {
        toArray: jest.fn(async () => jobs),
        get: jest.fn(async (id: string) => jobs.find((j) => j.id === id)),
        update: jest.fn(async (id: string, changes: Partial<PluginScheduledJobRow>) => {
          jobs = jobs.map((j) => (j.id === id ? { ...j, ...changes } : j))
          return 1
        }),
        delete: jest.fn(async (id: string) => {
          jobs = jobs.filter((j) => j.id !== id)
        }),
      },
    }
    return { db, getJobs: () => jobs }
  }

  it("list returns mapped rows", async () => {
    const stubs = makeStubs()
    const source = createPluginSource({ db: stubs.db })
    const items = await source.list()
    expect(items).toHaveLength(1)
    expect(items[0].unifiedId).toBe("plugin:job-1")
  })

  it("get returns undefined for missing ids", async () => {
    const stubs = makeStubs()
    const source = createPluginSource({ db: stubs.db })
    expect(await source.get("nope")).toBeUndefined()
  })

  it("create rejects with the documented sentinel error", async () => {
    const stubs = makeStubs()
    const source = createPluginSource({ db: stubs.db })
    await expect((source.create as () => Promise<unknown>)()).rejects.toBeInstanceOf(
      PluginSourceWriteNotSupportedError
    )
  })

  it("runNow rejects with the documented sentinel error", async () => {
    const stubs = makeStubs()
    const source = createPluginSource({ db: stubs.db })
    await expect((source.runNow as () => Promise<void>)()).rejects.toBeInstanceOf(
      PluginSourceWriteNotSupportedError
    )
  })

  it("pause sets status='paused'", async () => {
    const stubs = makeStubs()
    const source = createPluginSource({ db: stubs.db })
    await source.pause("job-1")
    expect(stubs.getJobs()[0].status).toBe("paused")
  })

  it("resume sets status='active'", async () => {
    const stubs = makeStubs([makeJob({ status: "paused" })])
    const source = createPluginSource({ db: stubs.db })
    await source.resume("job-1")
    expect(stubs.getJobs()[0].status).toBe("active")
  })

  it("delete removes the row", async () => {
    const stubs = makeStubs()
    const source = createPluginSource({ db: stubs.db })
    await source.delete("job-1")
    expect(stubs.getJobs()).toHaveLength(0)
  })

  it("update writes only the recognized fields", async () => {
    const stubs = makeStubs()
    const source = createPluginSource({ db: stubs.db })
    await source.update("job-1", { cron: "*/30 * * * *", args: { foo: 1 } })
    expect(stubs.getJobs()[0].cron).toBe("*/30 * * * *")
    expect(stubs.getJobs()[0].args).toEqual({ foo: 1 })
  })

  it("update is a no-op when no fields are provided", async () => {
    const stubs = makeStubs()
    const source = createPluginSource({ db: stubs.db })
    await source.update("job-1", {})
    expect(stubs.db.pluginScheduledJobs.update).not.toHaveBeenCalled()
  })
})
