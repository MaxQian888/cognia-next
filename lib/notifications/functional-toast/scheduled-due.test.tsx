/** @jest-environment jsdom */

import {
  SCHEDULED_DUE_META_KEY,
  buildScheduledDueMeta,
  readScheduledDueMeta,
  scheduledDueToastSpec,
  type ScheduledDueMeta,
} from "./scheduled-due"
import type { FunctionalToastContext } from "./types"
import type { NotificationAction, NotificationRecord } from "@/types/notifications"
import type { ScheduledTask } from "@/types/scheduler"

const NOW = Date.UTC(2025, 0, 15, 12, 0, 0)
const H = 60 * 60 * 1000

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "Provider diagnostics refresh",
    type: "provider-diagnostics-refresh",
    trigger: { type: "interval", intervalMs: 4 * H },
    config: { timeout: 60_000, maxRetries: 0, retryDelay: 0, runMissedOnStartup: false },
    notification: { onStart: false, onComplete: true, onError: true },
    status: "active",
    lastRunAt: new Date(NOW - 4 * H),
    nextRunAt: new Date(NOW + 4 * H),
    runCount: 128,
    successCount: 127,
    failureCount: 1,
    consecutiveFailures: 0,
    lastTerminalReason: "completed",
    projectId: "p1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

function makeRecord(
  meta: ScheduledDueMeta | undefined,
  actions?: NotificationAction[]
): NotificationRecord {
  return {
    id: "n1",
    source: "system",
    level: "info",
    title: "Scheduled task due",
    createdAt: NOW,
    updatedAt: NOW,
    readState: "unseen",
    count: 1,
    directed: true,
    deliveredVia: ["toast"],
    groupKey: "pet-scheduled-due",
    sourceRef: { kind: "task", id: "t1" },
    ...(meta ? { meta: { [SCHEDULED_DUE_META_KEY]: meta } } : {}),
    ...(actions ? { actions } : {}),
  }
}

function ctx(tOverride?: (k: string, v?: Record<string, string | number>) => string) {
  const t =
    tOverride ??
    ((key: string, values?: Record<string, string | number>) =>
      values ? `${key}|${JSON.stringify(values)}` : key)
  const c: FunctionalToastContext = {
    t,
    locale: "en",
    now: NOW,
    triggerText: () => "Every 4h",
  }
  return c
}

describe("buildScheduledDueMeta", () => {
  it("snapshots the task into the card's data shape", () => {
    const meta = buildScheduledDueMeta(makeTask(), "cognia")
    expect(meta).toMatchObject({
      taskId: "t1",
      kind: "app",
      name: "Provider diagnostics refresh",
      triggerSummary: { type: "interval", intervalMs: 4 * H },
      nextRunAtMs: NOW + 4 * H,
      lastRunAtMs: NOW - 4 * H,
      lastRunOk: true,
      runCount: 128,
      consecutiveFailures: 0,
      workspaceName: "cognia",
    })
  })

  it("maps plugin tasks to the plugin kind; others stay app", () => {
    expect(buildScheduledDueMeta(makeTask({ type: "plugin" })).kind).toBe("plugin")
    expect(buildScheduledDueMeta(makeTask({ type: "workflow" })).kind).toBe("app")
  })

  it("derives lastRunOk from lastTerminalReason, absent when unknown", () => {
    expect(buildScheduledDueMeta(makeTask()).lastRunOk).toBe(true)
    expect(
      buildScheduledDueMeta(makeTask({ lastTerminalReason: "executor-failure" })).lastRunOk
    ).toBe(false)
    expect(
      buildScheduledDueMeta(makeTask({ lastTerminalReason: undefined })).lastRunOk
    ).toBeUndefined()
  })

  it("reads back a well-formed record and rejects junk", () => {
    const rec = makeRecord(buildScheduledDueMeta(makeTask()))
    expect(readScheduledDueMeta(rec)?.taskId).toBe("t1")
    expect(readScheduledDueMeta(makeRecord(undefined))).toBeNull()
    expect(
      readScheduledDueMeta({ ...makeRecord(undefined), meta: { scheduledDue: 42 } })
    ).toBeNull()
    expect(
      readScheduledDueMeta({
        ...makeRecord(undefined),
        meta: { scheduledDue: { taskId: "t1" } },
      })
    ).toBeNull()
  })
})

describe("scheduledDueToastSpec", () => {
  const actions: NotificationAction[] = [
    {
      id: "open",
      label: "Open",
      command: "scheduler.open-task",
      args: { taskId: "t1" },
      variant: "primary",
    },
    { id: "mute", label: "Mute", command: "scheduled-due.mute", args: { taskId: "t1" } },
  ]

  it("builds the Agenda+ spec for a healthy recurring task", () => {
    const spec = scheduledDueToastSpec(
      makeRecord(buildScheduledDueMeta(makeTask()), actions),
      ctx()
    )
    expect(spec).not.toBeNull()
    expect(spec!.eyebrow).toEqual({ text: "scheduledDue.dueNow", tone: "live", pulse: true })
    expect(spec!.title).toBe("Provider diagnostics refresh")
    expect(spec!.accentClass).toBe("bg-primary")
    // Footer actions mirror the record's persisted actions, primary → strong.
    expect(spec!.actions).toEqual([
      expect.objectContaining({ id: "open", strong: true, notificationAction: actions[0] }),
      expect.objectContaining({ id: "mute", strong: false, notificationAction: actions[1] }),
    ])
    // The mute action carries its bell-off icon; open stays text-only.
    expect(spec!.actions![1]!.icon).toBeDefined()
    expect(spec!.actions![0]!.icon).toBeUndefined()
  })

  it("flips to the warn tone with the failure count when failing", () => {
    const meta = buildScheduledDueMeta(
      makeTask({ consecutiveFailures: 2, lastTerminalReason: "executor-failure" })
    )
    const spec = scheduledDueToastSpec(makeRecord(meta, actions), ctx())
    expect(spec!.eyebrow).toEqual({
      text: 'scheduledDue.dueFailed|{"count":2}',
      tone: "warn",
      pulse: true,
    })
  })

  it("localizes the timeline through the ctx translator and locale clock", () => {
    const seen: string[] = []
    const t = (k: string, v?: Record<string, string | number>) => {
      seen.push(k)
      return v ? `${k}|${JSON.stringify(v)}` : k
    }
    const spec = scheduledDueToastSpec(
      makeRecord(buildScheduledDueMeta(makeTask(), "cognia"), actions),
      ctx(t)
    )
    expect(seen).toEqual(
      expect.arrayContaining([
        "scheduledDue.dueNow",
        "scheduledDue.lastRan",
        "scheduledDue.now",
        "scheduledDue.next",
        "scheduledDue.runStartingIn",
      ])
    )
    expect(spec!.footnote).toContain("workspace")
  })

  it("renders a next-none node and a first-run node for one-shot tasks", () => {
    const seen: Record<string, Record<string, string | number> | undefined> = {}
    const t = (k: string, v?: Record<string, string | number>) => {
      seen[k] = v
      return k
    }
    const meta = buildScheduledDueMeta(
      makeTask({ nextRunAt: undefined, lastRunAt: undefined, runCount: 0 })
    )
    scheduledDueToastSpec(makeRecord(meta), ctx(t))
    expect(seen["scheduledDue.nextNone"]).toBeUndefined() // called with no values
    expect(seen["scheduledDue.neverRan"]).toBeUndefined()
    expect(Object.keys(seen)).toContain("scheduledDue.nextNone")
    expect(Object.keys(seen)).toContain("scheduledDue.neverRan")
  })

  it("returns null when the record carries no due meta", () => {
    expect(scheduledDueToastSpec(makeRecord(undefined), ctx())).toBeNull()
  })
})
