import { notify, type NotifyDeps, type NotifyDbPort } from "./notify"
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationRecord } from "@/types/notifications"
import { resolvePreferences } from "./preferences"

/** In-memory db port over a Map. */
function makeDb(): NotifyDbPort & { rows: Map<string, NotificationRecord>; pruneCalls: number } {
  const rows = new Map<string, NotificationRecord>()
  return {
    rows,
    pruneCalls: 0,
    async findByDedupeKey(key, sinceMs) {
      const hits = [...rows.values()].filter(
        (r) => r.dedupeKey === key && r.updatedAt >= sinceMs && r.readState !== "done"
      )
      return hits.sort((a, b) => b.updatedAt - a.updatedAt)[0]
    },
    async putNotification(rec) {
      rows.set(rec.id, rec)
    },
    async patchNotification(id, patch) {
      const cur = rows.get(id)
      if (cur) rows.set(id, { ...cur, ...patch })
    },
    async pruneNotifications() {
      this.pruneCalls += 1
      return 0
    },
  }
}

function baseDeps(over: Partial<NotifyDeps> = {}): NotifyDeps & { db: ReturnType<typeof makeDb> } {
  const db = makeDb()
  return {
    now: () => 10_000,
    loadPrefs: () =>
      resolvePreferences({ globalDefaultChannels: ["center", "toast", "os", "push"] }),
    db,
    newId: () => "fixed-id",
    tz: "UTC",
    ...over,
  } as NotifyDeps & { db: ReturnType<typeof makeDb> }
}

describe("notify — insert", () => {
  it("persists a center record and returns its id", async () => {
    const deps = baseDeps()
    const id = await notify({ source: "system", level: "info", title: "Hi" }, deps)
    expect(id).toBe("fixed-id")
    const row = deps.db.rows.get("fixed-id")!
    expect(row.title).toBe("Hi")
    expect(row.readState).toBe("unseen")
    expect(row.count).toBe(1)
  })

  it("fans out to toast/os/push and records deliveredVia", async () => {
    const toast = jest.fn()
    const osNotify = jest.fn()
    const push = jest.fn()
    const deps = baseDeps({ toast, osNotify, push })
    await notify(
      { source: "system", level: "warning", title: "T", body: "B", href: "/inbox" },
      deps
    )
    expect(toast).toHaveBeenCalledTimes(1)
    expect(osNotify).toHaveBeenCalledWith({ title: "T", body: "B", href: "/inbox" })
    expect(push).toHaveBeenCalledTimes(1)
    expect(deps.db.rows.get("fixed-id")!.deliveredVia.sort()).toEqual([
      "center",
      "os",
      "push",
      "toast",
    ])
  })

  it("fans out to the im channel when requested and records deliveredVia", async () => {
    const imDeliver = jest.fn()
    const deps = baseDeps({ imDeliver })
    await notify(
      {
        source: "connector",
        level: "info",
        title: "Task done",
        channels: ["center", "im"],
        sourceRef: { kind: "conversation", id: "telegram:tg-1:9" },
      },
      deps
    )
    expect(imDeliver).toHaveBeenCalledTimes(1)
    expect(deps.db.rows.get("fixed-id")!.deliveredVia).toContain("im")
  })

  it("calls onRecord for the reactive store", async () => {
    const onRecord = jest.fn()
    await notify({ source: "system", level: "info", title: "T" }, baseDeps({ onRecord }))
    expect(onRecord).toHaveBeenCalledTimes(1)
    expect(onRecord.mock.calls[0][0].title).toBe("T")
  })

  it("triggers best-effort retention", async () => {
    const deps = baseDeps()
    await notify({ source: "system", level: "info", title: "T" }, deps)
    await Promise.resolve()
    expect(deps.db.pruneCalls).toBe(1)
  })

  it("sets expiresAt from ttlMs", async () => {
    const deps = baseDeps()
    await notify({ source: "system", level: "info", title: "T", ttlMs: 5000 }, deps)
    expect(deps.db.rows.get("fixed-id")!.expiresAt).toBe(15_000)
  })
})

describe("notify — channel gating", () => {
  it("suppresses OS when permission is denied", async () => {
    const osNotify = jest.fn()
    const deps = baseDeps({ osNotify, isOsPermitted: () => false })
    await notify({ source: "system", level: "warning", title: "T" }, deps)
    expect(osNotify).not.toHaveBeenCalled()
    expect(deps.db.rows.get("fixed-id")!.deliveredVia).not.toContain("os")
  })

  it("isolates a failing channel from the persist + other channels", async () => {
    const toast = jest.fn(() => {
      throw new Error("toast boom")
    })
    const push = jest.fn()
    const deps = baseDeps({ toast, push })
    const id = await notify({ source: "system", level: "warning", title: "T" }, deps)
    expect(deps.db.rows.get(id)).toBeDefined()
    expect(push).toHaveBeenCalled()
    expect(deps.db.rows.get(id)!.deliveredVia).not.toContain("toast")
    expect(deps.db.rows.get(id)!.deliveredVia).toContain("push")
  })

  it("DND keeps only center (non-critical)", async () => {
    const toast = jest.fn()
    const osNotify = jest.fn()
    const deps = baseDeps({
      toast,
      osNotify,
      loadPrefs: () =>
        resolvePreferences({
          globalDefaultChannels: ["center", "toast", "os"],
          quietHours: { enabled: true, start: "00:00", end: "23:59" },
        }),
    })
    await notify({ source: "system", level: "warning", title: "T" }, deps)
    expect(toast).not.toHaveBeenCalled()
    expect(osNotify).not.toHaveBeenCalled()
    expect(deps.db.rows.get("fixed-id")!.deliveredVia).toEqual(["center"])
  })

  it("critical bypasses DND and fires OS", async () => {
    const osNotify = jest.fn()
    const deps = baseDeps({
      osNotify,
      loadPrefs: () =>
        resolvePreferences({
          globalDefaultChannels: ["center"],
          quietHours: { enabled: true, start: "00:00", end: "23:59" },
        }),
    })
    await notify({ source: "agent-team", level: "critical", title: "Approval" }, deps)
    expect(osNotify).toHaveBeenCalledTimes(1)
  })
})

describe("notify — coalescing", () => {
  it("bumps an existing record within the window instead of inserting", async () => {
    const deps = baseDeps()
    let t = 10_000
    deps.now = () => t
    let n = 0
    deps.newId = () => `id-${n++}`
    await notify({ source: "connector", level: "info", title: "msg 1", dedupeKey: "conv:1" }, deps)
    t = 15_000
    const second = await notify(
      { source: "connector", level: "info", title: "msg 2", dedupeKey: "conv:1" },
      deps
    )
    expect(second).toBe("id-0") // same record
    expect(deps.db.rows.size).toBe(1)
    const row = deps.db.rows.get("id-0")!
    expect(row.count).toBe(2)
    expect(row.title).toBe("msg 2")
    expect(row.readState).toBe("unseen")
  })

  it("inserts a fresh record once the coalesce window lapses", async () => {
    const deps = baseDeps()
    let t = 10_000
    deps.now = () => t
    let n = 0
    deps.newId = () => `id-${n++}`
    await notify({ source: "connector", level: "info", title: "a", dedupeKey: "k" }, deps)
    t = 10_000 + 60_000 // beyond 45s window
    await notify({ source: "connector", level: "info", title: "b", dedupeKey: "k" }, deps)
    expect(deps.db.rows.size).toBe(2)
  })

  it("escalates level on bump (info → error)", async () => {
    const deps = baseDeps()
    deps.newId = () => "one"
    await notify({ source: "scheduler", level: "info", title: "run", dedupeKey: "task:1" }, deps)
    await notify(
      { source: "scheduler", level: "error", title: "run failed", dedupeKey: "task:1" },
      deps
    )
    expect(deps.db.rows.get("one")!.level).toBe("error")
  })
})

describe("notify — defaults", () => {
  it("uses real defaults when prefs are absent", async () => {
    const deps = baseDeps({ loadPrefs: () => DEFAULT_NOTIFICATION_PREFERENCES })
    const toast = jest.fn()
    deps.toast = toast
    await notify({ source: "system", level: "info", title: "T" }, deps)
    // default channels = center+toast → toast fires
    expect(toast).toHaveBeenCalled()
  })
})
