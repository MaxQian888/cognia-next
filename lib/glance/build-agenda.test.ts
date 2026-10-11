import type { NotificationReadState } from "@/types/notifications"
import { makeUnifiedId, unifiedKindForTaskType } from "@/types/scheduler/unified"

import {
  buildAgendaSlice,
  unreadNotifications,
  type AgendaExecutionInput,
  type AgendaTaskInput,
  type BuildAgendaSliceInput,
} from "./build-agenda"

const NOW = 1_800_000_000_000
const CONNECTIVITY = { state: "paired", connected: 1, total: 2, lastContactAt: NOW - 5 } as const

type N = BuildAgendaSliceInput["notifications"][number]

function note(readState: NotificationReadState, extra: Partial<N> = {}): N {
  return { readState, directed: false, title: "Title", createdAt: 1, ...extra }
}

function build(patch: Partial<BuildAgendaSliceInput> = {}) {
  return buildAgendaSlice({
    schedulerLocal: true,
    nextTask: null,
    recentExecutions: [],
    notifications: [],
    connectivity: CONNECTIVITY,
    now: NOW,
    ...patch,
  })
}

const task = (extra: Partial<AgendaTaskInput> = {}): AgendaTaskInput => ({
  id: "t1",
  type: "cron",
  name: "Morning brief",
  nextRunAt: NOW + 1000,
  ...extra,
})

const exec = (extra: Partial<AgendaExecutionInput> = {}): AgendaExecutionInput => ({
  taskName: "Brief",
  status: "completed",
  startedAt: 10,
  completedAt: 20,
  ...extra,
})

describe("unreadNotifications", () => {
  it("excludes done records", () => {
    expect(unreadNotifications([note("done"), note("done", { directed: true })], NOW)).toEqual([])
  })

  it("excludes snoozed records, but includes ones whose snooze elapsed", () => {
    const out = unreadNotifications(
      [
        note("unseen", { snoozedUntil: NOW + 1, title: "snoozed" }),
        note("unseen", { snoozedUntil: NOW, title: "elapsed" }),
        note("unseen", { snoozedUntil: NOW - 10, title: "old" }),
      ],
      NOW
    )
    expect(out.map((r) => r.title)).toEqual(["elapsed", "old"])
  })

  it("counts every unseen record once, directed or not", () => {
    const out = unreadNotifications([note("unseen"), note("unseen", { directed: true })], NOW)
    expect(out).toHaveLength(2)
  })

  it("counts a seen record only when it is directed", () => {
    const out = unreadNotifications(
      [note("seen", { directed: true, title: "yes" }), note("seen", { title: "no" })],
      NOW
    )
    expect(out.map((r) => r.title)).toEqual(["yes"])
  })

  it("excludes read records even when directed", () => {
    expect(unreadNotifications([note("read", { directed: true }), note("read")], NOW)).toEqual([])
  })

  it("returns the original objects", () => {
    const a = note("unseen")
    expect(unreadNotifications([a], NOW)[0]).toBe(a)
  })
})

describe("buildAgendaSlice", () => {
  it("returns an empty agenda stamped with now and the given connectivity", () => {
    expect(build()).toEqual({
      updatedAt: NOW,
      schedulerLocal: true,
      nextRun: null,
      lastOutcome: null,
      unread: 0,
      latestUnreadTitle: null,
      connectivity: CONNECTIVITY,
    })
  })

  describe("unread", () => {
    it("applies the union semantics and counts each record once", () => {
      const slice = build({
        notifications: [
          note("unseen", { directed: true }), // counted once, not twice
          note("unseen"),
          note("seen", { directed: true }),
          note("seen"), // excluded
          note("read", { directed: true }), // excluded
          note("done"), // excluded
          note("unseen", { snoozedUntil: NOW + 5000 }), // excluded
        ],
      })
      expect(slice.unread).toBe(3)
    })

    it("uses the newest unread record's title", () => {
      const slice = build({
        notifications: [
          note("unseen", { title: "older", createdAt: 10 }),
          note("unseen", { title: "newest", createdAt: 30 }),
          note("seen", { title: "ignored newer but read", createdAt: 99 }),
          note("unseen", { title: "middle", createdAt: 20 }),
        ],
      })
      expect(slice.latestUnreadTitle).toBe("newest")
    })

    it("does not mutate the notification array", () => {
      const notifications = [note("unseen", { createdAt: 1 }), note("unseen", { createdAt: 2 })]
      build({ notifications })
      expect(notifications.map((n) => n.createdAt)).toEqual([1, 2])
    })

    it("redacts and truncates the title", () => {
      const key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      const secret = build({ notifications: [note("unseen", { title: `leaked ${key}` })] })
      expect(secret.latestUnreadTitle).not.toContain(key)
      const long = build({ notifications: [note("unseen", { title: "w".repeat(300) })] })
      expect(long.latestUnreadTitle!.length).toBeLessThanOrEqual(80)
      expect(long.latestUnreadTitle!.endsWith("…")).toBe(true)
    })
  })

  describe("nextRun", () => {
    it.each([
      ["cron", "app"],
      ["interval", "app"],
      ["plugin", "plugin"],
      ["connection:slack", "connector"],
    ])("builds the unified id for task type %s (%s:)", (type, prefix) => {
      const slice = build({ nextTask: task({ type, id: "abc" }) })
      expect(slice.nextRun!.itemId).toBe(`${prefix}:abc`)
      expect(slice.nextRun!.itemId).toBe(makeUnifiedId(unifiedKindForTaskType(type), "abc"))
    })

    it("carries name and time", () => {
      const slice = build({ nextTask: task({ name: "Morning brief", nextRunAt: 777 }) })
      expect(slice.nextRun).toEqual({ itemId: "app:t1", name: "Morning brief", at: 777 })
    })

    it("caps a long name at 64 characters", () => {
      const slice = build({ nextTask: task({ name: "n".repeat(200) }) })
      expect(slice.nextRun!.name.length).toBeLessThanOrEqual(64)
      expect(slice.nextRun!.name.endsWith("…")).toBe(true)
    })

    it("redacts secrets in the name", () => {
      const email = "jane.doe@example.com"
      const slice = build({ nextTask: task({ name: `Mail ${email}` }) })
      expect(slice.nextRun!.name).not.toContain(email)
    })

    it("is null with no task", () => {
      expect(build({ nextTask: null }).nextRun).toBeNull()
    })
  })

  describe("lastOutcome", () => {
    it("takes the first completed or failed execution, skipping running ones", () => {
      const slice = build({
        recentExecutions: [
          exec({ status: "running", taskName: "live", completedAt: null }),
          exec({ status: "failed", taskName: "broke", startedAt: 100, completedAt: 150 }),
          exec({ status: "completed", taskName: "older ok" }),
        ],
      })
      expect(slice.lastOutcome).toEqual({ ok: false, at: 150, name: "broke" })
    })

    it("reports ok for a completed execution", () => {
      expect(build({ recentExecutions: [exec()] }).lastOutcome).toEqual({
        ok: true,
        at: 20,
        name: "Brief",
      })
    })

    it("falls back to startedAt when there is no completion time", () => {
      const slice = build({ recentExecutions: [exec({ completedAt: null, startedAt: 42 })] })
      expect(slice.lastOutcome!.at).toBe(42)
    })

    it("is null when nothing terminal has happened", () => {
      expect(
        build({ recentExecutions: [exec({ status: "running" }), exec({ status: "pending" })] })
          .lastOutcome
      ).toBeNull()
      expect(build({ recentExecutions: [] }).lastOutcome).toBeNull()
    })

    it("caps and redacts the name", () => {
      const slice = build({ recentExecutions: [exec({ taskName: "t".repeat(200) })] })
      expect(slice.lastOutcome!.name.length).toBeLessThanOrEqual(64)
    })
  })

  describe("schedulerLocal = false", () => {
    it("nulls nextRun and lastOutcome but still reports notifications and connectivity", () => {
      const slice = build({
        schedulerLocal: false,
        nextTask: task(),
        recentExecutions: [exec()],
        notifications: [note("unseen", { title: "hello" })],
      })
      expect(slice.schedulerLocal).toBe(false)
      expect(slice.nextRun).toBeNull()
      expect(slice.lastOutcome).toBeNull()
      expect(slice.unread).toBe(1)
      expect(slice.latestUnreadTitle).toBe("hello")
      expect(slice.connectivity).toBe(CONNECTIVITY)
    })
  })
})
