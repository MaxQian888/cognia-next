import type { NotificationRecord } from "@/types/notifications"

jest.mock("@/lib/db/notifications", () => ({
  listNotifications: jest.fn(),
  getNotification: jest.fn(),
  patchNotification: jest.fn(),
  deleteNotification: jest.fn(),
  clearNotifications: jest.fn(),
}))

import * as dbModule from "@/lib/db/notifications"
import { useNotificationStore, recomputeCounts } from "./notification-store"

const db = dbModule as jest.Mocked<typeof dbModule>

function rec(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: over.id ?? "n1",
    source: over.source ?? "system",
    level: over.level ?? "info",
    title: over.title ?? "T",
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
    readState: over.readState ?? "unseen",
    count: over.count ?? 1,
    directed: over.directed ?? false,
    deliveredVia: over.deliveredVia ?? ["center"],
    snoozedUntil: over.snoozedUntil,
    ...over,
  }
}

const reset = () =>
  useNotificationStore.setState({
    items: [],
    directedUnread: 0,
    ambientUnseen: 0,
    hydrated: false,
    sourceFilter: undefined,
  })

beforeEach(() => {
  jest.clearAllMocks()
  db.patchNotification.mockResolvedValue(undefined)
  db.deleteNotification.mockResolvedValue(undefined)
  db.clearNotifications.mockResolvedValue(undefined)
  db.listNotifications.mockResolvedValue([])
  reset()
})

describe("recomputeCounts", () => {
  it("counts directed-unread and ambient-unseen, skipping done/snoozed", () => {
    const items = [
      rec({ id: "a", directed: true, readState: "unseen" }),
      rec({ id: "b", directed: true, readState: "seen" }),
      rec({ id: "c", directed: false, readState: "unseen" }),
      rec({ id: "d", directed: true, readState: "read" }),
      rec({ id: "e", directed: true, readState: "done" }),
      rec({ id: "f", directed: true, readState: "unseen", snoozedUntil: 9_999_999_999_999 }),
    ]
    const counts = recomputeCounts(items, 1000)
    expect(counts.directedUnread).toBe(2) // a + b
    expect(counts.ambientUnseen).toBe(2) // a + c
  })
})

describe("hydrate", () => {
  it("loads the active feed and computes counts", async () => {
    db.listNotifications.mockResolvedValueOnce([rec({ id: "a", directed: true })])
    await useNotificationStore.getState().hydrate()
    const s = useNotificationStore.getState()
    expect(s.hydrated).toBe(true)
    expect(s.items.map((r) => r.id)).toEqual(["a"])
    expect(s.directedUnread).toBe(1)
  })
})

describe("ingest", () => {
  it("inserts a new record at the front", () => {
    useNotificationStore.setState({ items: [rec({ id: "old" })] })
    useNotificationStore.getState().ingest(rec({ id: "new" }))
    expect(useNotificationStore.getState().items.map((r) => r.id)).toEqual(["new", "old"])
  })

  it("replaces an existing record by id (coalesce bump)", () => {
    useNotificationStore.setState({ items: [rec({ id: "a", count: 1 })] })
    useNotificationStore.getState().ingest(rec({ id: "a", count: 2 }))
    const items = useNotificationStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].count).toBe(2)
  })

  it("removes a row if a bump arrives already done", () => {
    useNotificationStore.setState({ items: [rec({ id: "a" })] })
    useNotificationStore.getState().ingest(rec({ id: "a", readState: "done" }))
    expect(useNotificationStore.getState().items).toHaveLength(0)
  })
})

describe("read-state actions", () => {
  it("markSeen persists and recounts", async () => {
    useNotificationStore.setState({
      items: [rec({ id: "a", directed: true, readState: "unseen" })],
    })
    await useNotificationStore.getState().markSeen("a")
    expect(db.patchNotification).toHaveBeenCalledWith(
      "a",
      expect.objectContaining({ readState: "seen" })
    )
    expect(useNotificationStore.getState().items[0].readState).toBe("seen")
    expect(useNotificationStore.getState().ambientUnseen).toBe(0)
  })

  it("markSeen is a no-op for an unknown id", async () => {
    await useNotificationStore.getState().markSeen("ghost")
    expect(db.patchNotification).not.toHaveBeenCalled()
  })

  it("markSeen does not downgrade an already-read record", async () => {
    useNotificationStore.setState({ items: [rec({ id: "a", readState: "read" })] })
    await useNotificationStore.getState().markSeen("a")
    expect(db.patchNotification).not.toHaveBeenCalled()
  })

  it("markRead persists read state", async () => {
    useNotificationStore.setState({ items: [rec({ id: "a", readState: "unseen" })] })
    await useNotificationStore.getState().markRead("a")
    expect(useNotificationStore.getState().items[0].readState).toBe("read")
  })

  it("markRead is a no-op for unknown id and for already-read rows", async () => {
    await useNotificationStore.getState().markRead("ghost")
    useNotificationStore.setState({ items: [rec({ id: "a", readState: "read" })] })
    await useNotificationStore.getState().markRead("a")
    expect(db.patchNotification).not.toHaveBeenCalled()
  })

  it("markDone is a no-op for unknown id", async () => {
    await useNotificationStore.getState().markDone("ghost")
    expect(db.patchNotification).not.toHaveBeenCalled()
  })

  it("markDone removes the row from the active feed", async () => {
    useNotificationStore.setState({ items: [rec({ id: "a" }), rec({ id: "b" })] })
    await useNotificationStore.getState().markDone("a")
    expect(db.patchNotification).toHaveBeenCalled()
    expect(useNotificationStore.getState().items.map((r) => r.id)).toEqual(["b"])
  })

  it("markAllRead reads every unseen/seen row", async () => {
    useNotificationStore.setState({
      items: [
        rec({ id: "a", readState: "unseen" }),
        rec({ id: "b", readState: "seen" }),
        rec({ id: "c", readState: "read" }),
      ],
    })
    await useNotificationStore.getState().markAllRead()
    expect(db.patchNotification).toHaveBeenCalledTimes(2)
    const states = useNotificationStore.getState().items.map((r) => r.readState)
    expect(states).toEqual(["read", "read", "read"])
  })

  it("archiveAll moves every active row to done and empties the feed", async () => {
    useNotificationStore.setState({
      items: [rec({ id: "a", directed: true }), rec({ id: "b", readState: "read" })],
      directedUnread: 1,
      ambientUnseen: 1,
    })
    await useNotificationStore.getState().archiveAll()
    expect(db.patchNotification).toHaveBeenCalledTimes(2)
    const state = useNotificationStore.getState()
    expect(state.items).toEqual([])
    expect(state.directedUnread).toBe(0)
    expect(state.ambientUnseen).toBe(0)
  })

  it("archiveAll is a no-op on an already-empty feed", async () => {
    useNotificationStore.setState({ items: [] })
    await useNotificationStore.getState().archiveAll()
    expect(db.patchNotification).not.toHaveBeenCalled()
    expect(useNotificationStore.getState().items).toEqual([])
  })

  it("restore moves an archived record back to the active feed as read", async () => {
    db.getNotification.mockResolvedValueOnce(
      rec({ id: "archived", readState: "done", doneAt: 123 })
    )

    await useNotificationStore.getState().restore("archived")

    expect(db.patchNotification).toHaveBeenCalledWith("archived", {
      readState: "read",
      doneAt: undefined,
    })
    expect(useNotificationStore.getState().items).toEqual([
      expect.objectContaining({ id: "archived", readState: "read", doneAt: undefined }),
    ])
  })

  it("restore ignores a missing or already-active record", async () => {
    db.getNotification
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(rec({ id: "active", readState: "read" }))

    await useNotificationStore.getState().restore("missing")
    await useNotificationStore.getState().restore("active")

    expect(db.patchNotification).not.toHaveBeenCalled()
    expect(useNotificationStore.getState().items).toEqual([])
  })
})

describe("snooze", () => {
  it("snooze removes from feed and persists snoozedUntil", async () => {
    useNotificationStore.setState({ items: [rec({ id: "a" })] })
    await useNotificationStore.getState().snooze("a", 60_000)
    expect(db.patchNotification).toHaveBeenCalledWith(
      "a",
      expect.objectContaining({ snoozedUntil: expect.any(Number) })
    )
    expect(useNotificationStore.getState().items).toHaveLength(0)
  })

  it("unsnooze re-fetches and re-inserts an active record", async () => {
    db.getNotification.mockResolvedValueOnce(rec({ id: "a", readState: "unseen" }))
    await useNotificationStore.getState().unsnooze("a")
    expect(db.patchNotification).toHaveBeenCalledWith("a", { snoozedUntil: undefined })
    expect(useNotificationStore.getState().items.map((r) => r.id)).toEqual(["a"])
  })

  it("unsnooze does not re-insert a done record", async () => {
    db.getNotification.mockResolvedValueOnce(rec({ id: "a", readState: "done" }))
    await useNotificationStore.getState().unsnooze("a")
    expect(useNotificationStore.getState().items).toHaveLength(0)
  })

  it("unsnooze tolerates a record that no longer exists", async () => {
    db.getNotification.mockResolvedValueOnce(undefined)
    await useNotificationStore.getState().unsnooze("gone")
    expect(db.patchNotification).toHaveBeenCalledWith("gone", { snoozedUntil: undefined })
    expect(useNotificationStore.getState().items).toHaveLength(0)
  })
})

describe("remove / clear / filter", () => {
  it("remove deletes and drops from feed", async () => {
    useNotificationStore.setState({ items: [rec({ id: "a" }), rec({ id: "b" })] })
    await useNotificationStore.getState().remove("a")
    expect(db.deleteNotification).toHaveBeenCalledWith("a")
    expect(useNotificationStore.getState().items.map((r) => r.id)).toEqual(["b"])
  })

  it("clearAll empties everything", async () => {
    useNotificationStore.setState({ items: [rec({ id: "a" })], directedUnread: 1 })
    await useNotificationStore.getState().clearAll()
    expect(db.clearNotifications).toHaveBeenCalled()
    expect(useNotificationStore.getState().items).toHaveLength(0)
    expect(useNotificationStore.getState().directedUnread).toBe(0)
  })

  it("setSourceFilter updates the filter", () => {
    useNotificationStore.getState().setSourceFilter("connector")
    expect(useNotificationStore.getState().sourceFilter).toBe("connector")
  })
})
