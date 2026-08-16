import { createSystemSource, toUnifiedSystemTask } from "./system-source"
import type { SystemTask } from "@/types/scheduler"

function makeSystemTask(overrides: Partial<SystemTask> = {}): SystemTask {
  return {
    id: "sys-1",
    name: "Backup index",
    description: "Indexes my docs nightly",
    trigger: { type: "cron", expression: "0 3 * * *", timezone: "UTC" },
    action: { type: "run_command", command: "echo", args: ["hi"] },
    run_level: "user",
    status: "enabled",
    requires_admin: false,
    tags: ["backup"],
    next_run_at: "2026-05-12T03:00:00Z",
    last_run_at: "2026-05-11T03:00:00Z",
    ...overrides,
  } as SystemTask
}

describe("toUnifiedSystemTask", () => {
  it("maps an enabled cron task to an active unified item", () => {
    const u = toUnifiedSystemTask(makeSystemTask())
    expect(u.unifiedId).toBe("system:sys-1")
    expect(u.kind).toBe("system")
    expect(u.status).toBe("active")
    expect(u.triggerSummary).toEqual({
      type: "cron",
      cron: "0 3 * * *",
      timezone: "UTC",
    })
    expect(u.nextRunAt).toBe(Date.parse("2026-05-12T03:00:00Z"))
    expect(u.lastRunAt).toBe(Date.parse("2026-05-11T03:00:00Z"))
    expect(u.capabilities).toEqual({ runNow: true, pause: true, edit: true, delete: true })
  })

  it("maps disabled status to paused", () => {
    expect(toUnifiedSystemTask(makeSystemTask({ status: "disabled" })).status).toBe("paused")
  })

  it("maps failed status to disabled", () => {
    expect(toUnifiedSystemTask(makeSystemTask({ status: "failed" })).status).toBe("disabled")
  })

  it("maps unknown status to 'unknown'", () => {
    expect(toUnifiedSystemTask(makeSystemTask({ status: "unknown" })).status).toBe("unknown")
  })

  it("converts an interval trigger to ms", () => {
    const u = toUnifiedSystemTask(makeSystemTask({ trigger: { type: "interval", seconds: 60 } }))
    expect(u.triggerSummary).toEqual({ type: "interval", intervalMs: 60_000 })
  })

  it("converts a once trigger to runAtMs", () => {
    const u = toUnifiedSystemTask(
      makeSystemTask({ trigger: { type: "once", run_at: "2026-12-25T08:00:00Z" } })
    )
    expect(u.triggerSummary).toEqual({
      type: "once",
      runAtMs: Date.parse("2026-12-25T08:00:00Z"),
    })
  })

  it("falls back to event type for boot/logon/event triggers", () => {
    const u = toUnifiedSystemTask(
      makeSystemTask({ trigger: { type: "on_boot", delay_seconds: 5 } })
    )
    expect(u.triggerSummary.type).toBe("event")
    expect(u.triggerSummary.eventType).toBe("on_boot")
  })
})

describe("createSystemSource", () => {
  function makeStubs(initial: SystemTask[] = [makeSystemTask()]) {
    let tasks = [...initial]
    const native = {
      listSystemTasks: jest.fn(async () => tasks),
      getSystemTask: jest.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
      createSystemTask: jest.fn(async (input: { name: string }) => {
        const fresh = makeSystemTask({ id: "fresh-id", name: input.name })
        tasks = [...tasks, fresh]
        return { task: fresh }
      }),
      updateSystemTask: jest.fn(async () => ({})),
      deleteSystemTask: jest.fn(async (id: string) => {
        tasks = tasks.filter((t) => t.id !== id)
        return true
      }),
      enableSystemTask: jest.fn(async (id: string) => {
        tasks = tasks.map((t) => (t.id === id ? { ...t, status: "enabled" } : t))
        return true
      }),
      disableSystemTask: jest.fn(async (id: string) => {
        tasks = tasks.map((t) => (t.id === id ? { ...t, status: "disabled" } : t))
        return true
      }),
      runSystemTaskNow: jest.fn(async () => ({})),
    }
    return { native, getTasks: () => tasks }
  }

  it("returns an empty list when running outside Tauri", async () => {
    const stubs = makeStubs()
    const source = createSystemSource({
      native: stubs.native,
      isAvailable: () => false,
      pollIntervalMs: 0,
    })
    expect(await source.list()).toEqual([])
  })

  it("defaults availability to the local host's desktop-shell capability", async () => {
    // jsdom / node test hosts are neither Tauri nor headless: no desktop shell,
    // so the default gate (no `isAvailable` injected) yields an empty list
    // without touching the native adapter.
    const stubs = makeStubs()
    const source = createSystemSource({ native: stubs.native, pollIntervalMs: 0 })
    expect(await source.list()).toEqual([])
    expect(stubs.native.listSystemTasks).not.toHaveBeenCalled()
  })

  it("returns unified items when Tauri is available", async () => {
    const stubs = makeStubs()
    const source = createSystemSource({
      native: stubs.native,
      isAvailable: () => true,
      pollIntervalMs: 0,
    })
    const items = await source.list()
    expect(items).toHaveLength(1)
    expect(items[0].unifiedId).toBe("system:sys-1")
  })

  it("get() returns undefined when not available", async () => {
    const stubs = makeStubs()
    const source = createSystemSource({
      native: stubs.native,
      isAvailable: () => false,
      pollIntervalMs: 0,
    })
    expect(await source.get("sys-1")).toBeUndefined()
  })

  it("create() returns the unified shape of the new task", async () => {
    const stubs = makeStubs()
    const source = createSystemSource({
      native: stubs.native,
      isAvailable: () => true,
      pollIntervalMs: 0,
    })
    const created = await source.create({
      name: "New",
      trigger: { type: "cron", expression: "0 0 * * *" },
      action: { type: "run_command", command: "echo" },
    })
    expect(created.unifiedId).toBe("system:fresh-id")
    expect(stubs.native.createSystemTask).toHaveBeenCalled()
  })

  it("pause invokes disableSystemTask", async () => {
    const stubs = makeStubs()
    const source = createSystemSource({
      native: stubs.native,
      isAvailable: () => true,
      pollIntervalMs: 0,
    })
    await source.pause("sys-1")
    expect(stubs.native.disableSystemTask).toHaveBeenCalledWith("sys-1")
  })

  it("resume invokes enableSystemTask", async () => {
    const stubs = makeStubs()
    const source = createSystemSource({
      native: stubs.native,
      isAvailable: () => true,
      pollIntervalMs: 0,
    })
    await source.resume("sys-1")
    expect(stubs.native.enableSystemTask).toHaveBeenCalledWith("sys-1")
  })

  it("delete + runNow route through the native adapter", async () => {
    const stubs = makeStubs()
    const source = createSystemSource({
      native: stubs.native,
      isAvailable: () => true,
      pollIntervalMs: 0,
    })
    await source.delete("sys-1")
    await source.runNow("sys-1")
    expect(stubs.native.deleteSystemTask).toHaveBeenCalledWith("sys-1")
    expect(stubs.native.runSystemTaskNow).toHaveBeenCalledWith("sys-1")
  })

  it("subscribe emits an empty array when not available", async () => {
    const stubs = makeStubs()
    const source = createSystemSource({
      native: stubs.native,
      isAvailable: () => false,
      pollIntervalMs: 0,
    })
    const seen: number[] = []
    const sub = source.subscribe({ next: (items) => seen.push(items.length) })
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual([0])
    sub.unsubscribe()
  })
})
