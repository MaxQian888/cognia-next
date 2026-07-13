import { BACKUP_SOURCE_ID, createBackupSource, toUnifiedBackup } from "./backup-source"
import type { BackupAutoSchedule } from "@cognia/agent-config-types"

function makeConfig(overrides: Partial<BackupAutoSchedule> = {}): BackupAutoSchedule {
  return {
    enabled: true,
    intervalDays: 7,
    retainCount: 5,
    dirPath: "/tmp/backups",
    lastRunAt: "2026-05-01T00:00:00Z",
    ...overrides,
  }
}

describe("toUnifiedBackup", () => {
  it("derives nextRunAt from lastRunAt + intervalDays when active", () => {
    const u = toUnifiedBackup(makeConfig())
    expect(u.kind).toBe("backup")
    expect(u.unifiedId).toBe(`backup:${BACKUP_SOURCE_ID}`)
    expect(u.status).toBe("active")
    expect(u.triggerSummary.type).toBe("interval")
    expect(u.triggerSummary.intervalMs).toBe(7 * 24 * 60 * 60 * 1000)
    const expectedNext = Date.parse("2026-05-01T00:00:00Z") + 7 * 24 * 60 * 60 * 1000
    expect(u.nextRunAt).toBe(expectedNext)
  })

  it("returns paused when the schedule is disabled", () => {
    expect(toUnifiedBackup(makeConfig({ enabled: false })).status).toBe("paused")
  })

  it("returns disabled when enabled but no destination folder is set", () => {
    expect(toUnifiedBackup(makeConfig({ dirPath: undefined })).status).toBe("disabled")
  })

  it("falls back to defaults when no config row exists", () => {
    const u = toUnifiedBackup(undefined)
    expect(u.status).toBe("paused") // default has enabled=false
    expect(u.triggerSummary.intervalMs).toBe(7 * 24 * 60 * 60 * 1000)
    expect(u.nextRunAt).toBeUndefined()
  })

  it("nextRunAt is undefined when there is no lastRunAt", () => {
    const u = toUnifiedBackup(makeConfig({ lastRunAt: undefined }))
    expect(u.nextRunAt).toBeUndefined()
  })

  it("capabilities reflect that the singleton can't be created/deleted", () => {
    const u = toUnifiedBackup(makeConfig())
    expect(u.capabilities).toEqual({ runNow: true, pause: true, edit: true, delete: false })
  })
})

describe("createBackupSource", () => {
  function makeStubs(initial?: BackupAutoSchedule) {
    let current = initial
    const read = jest.fn(async () => current)
    const write = jest.fn(async (next: BackupAutoSchedule) => {
      current = next
    })
    const runNow = jest.fn(async () => true)
    return { read, write, runNow, getCurrent: () => current }
  }

  it("list() returns exactly one item — the singleton schedule", async () => {
    const stubs = makeStubs(makeConfig())
    const source = createBackupSource({ ...stubs, pollIntervalMs: 0 })
    const items = await source.list()
    expect(items).toHaveLength(1)
    expect(items[0].unifiedId).toBe(`backup:${BACKUP_SOURCE_ID}`)
  })

  it("get() returns undefined for non-default ids", async () => {
    const stubs = makeStubs(makeConfig())
    const source = createBackupSource({ ...stubs, pollIntervalMs: 0 })
    expect(await source.get("anything-else")).toBeUndefined()
    expect((await source.get(BACKUP_SOURCE_ID))?.kind).toBe("backup")
  })

  it("pause toggles enabled to false", async () => {
    const stubs = makeStubs(makeConfig({ enabled: true }))
    const source = createBackupSource({ ...stubs, pollIntervalMs: 0 })
    await source.pause(BACKUP_SOURCE_ID)
    expect(stubs.getCurrent()?.enabled).toBe(false)
  })

  it("resume toggles enabled to true", async () => {
    const stubs = makeStubs(makeConfig({ enabled: false }))
    const source = createBackupSource({ ...stubs, pollIntervalMs: 0 })
    await source.resume(BACKUP_SOURCE_ID)
    expect(stubs.getCurrent()?.enabled).toBe(true)
  })

  it("update merges partial changes into the existing config", async () => {
    const stubs = makeStubs(makeConfig({ intervalDays: 3 }))
    const source = createBackupSource({ ...stubs, pollIntervalMs: 0 })
    await source.update(BACKUP_SOURCE_ID, { intervalDays: 14, retainCount: 10 })
    expect(stubs.getCurrent()).toMatchObject({
      intervalDays: 14,
      retainCount: 10,
      enabled: true,
    })
  })

  it("delete resets to disabled defaults rather than removing the row", async () => {
    const stubs = makeStubs(makeConfig({ enabled: true, intervalDays: 30 }))
    const source = createBackupSource({ ...stubs, pollIntervalMs: 0 })
    await source.delete(BACKUP_SOURCE_ID)
    expect(stubs.getCurrent()?.enabled).toBe(false)
    expect(stubs.getCurrent()?.intervalDays).toBe(7) // default
  })

  it("runNow calls the underlying scheduler tick", async () => {
    const stubs = makeStubs(makeConfig())
    const source = createBackupSource({ ...stubs, pollIntervalMs: 0 })
    await source.runNow(BACKUP_SOURCE_ID)
    expect(stubs.runNow).toHaveBeenCalledTimes(1)
  })

  it("subscribe emits the current item synchronously and exposes unsubscribe", async () => {
    const stubs = makeStubs(makeConfig())
    const source = createBackupSource({ ...stubs, pollIntervalMs: 0 })
    const seen: number[] = []
    const sub = source.subscribe({
      next: (items) => seen.push(items.length),
    })
    // emit() is async — wait a microtask for it to resolve.
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual([1])
    sub.unsubscribe()
  })
})
