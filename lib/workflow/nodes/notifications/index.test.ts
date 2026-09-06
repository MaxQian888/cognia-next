/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

// Typed with its parameter rather than `(...a: unknown[])`: a zero-arg
// `jest.fn` infers an empty tuple, and both the spread and every
// `mock.calls[0][0]` read below then fail to compile (TS2556 / TS2493).
const notifyMock = jest.fn(async (_input: unknown): Promise<string> => "n1")
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (input: unknown) => notifyMock(input),
}))

import { getNotification, putNotification } from "@/lib/db/notifications"
import type { NotificationRecord } from "@/types/notifications"
import "."
import { getExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

function run(kind: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const executor = getExecutor(kind as never, 1)!
  return executor.execute({
    params,
    workflowId: "wf1",
    runId: "run1",
    stepId: "s1",
    projectId: "proj1",
    ...extra,
  } as unknown as StepExecutionContext)
}

function record(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "n1",
    source: "workflow",
    level: "info",
    title: "T",
    readState: "unseen",
    directed: false,
    createdAt: 1000,
    count: 1,
    deliveredVia: ["center", "toast"],
    ...over,
  } as NotificationRecord
}

beforeEach(async () => {
  jest.clearAllMocks()
  notifyMock.mockResolvedValue("n1")
  const { getDb } = await import("@/lib/db/schema")
  await getDb().notifications.clear()
})

describe("registration", () => {
  it.each(["action.notify.send", "action.notify.list", "action.notify.resolve"])(
    "registers %s",
    (kind) => {
      expect(getExecutor(kind as never, 1)).toBeDefined()
    }
  )

  it("does not retry a send, because a retry raises a second notification", () => {
    expect(getExecutor("action.notify.send" as never, 1)!.retryable).toBe(false)
  })
})

describe("action.notify.send", () => {
  it("stamps the workflow source, the workspace and the run reference", async () => {
    await putNotification(record())
    await run("action.notify.send", { title: "Build finished" })
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(notifyMock.mock.calls[0][0]).toMatchObject({
      source: "workflow",
      level: "info",
      title: "Build finished",
      // ADR-0144: a notification that cannot name its workspace makes the user
      // click through to find out where it came from.
      projectId: "proj1",
      sourceRef: { kind: "workflow-run", id: "run1" },
      groupKey: "wf1",
    })
  })

  it("dedupes on the step, so a retry bumps the row instead of stacking one", async () => {
    await putNotification(record())
    await run("action.notify.send", { title: "T" })
    expect(notifyMock.mock.calls[0][0]).toMatchObject({ dedupeKey: "run1:s1" })
  })

  it("refuses authored actions, which would render a button that does nothing", async () => {
    // `NotificationAction.command` resolves through the action registry at
    // click time. An unregistered command logs a warning and does nothing.
    await putNotification(record())
    await run("action.notify.send", {
      title: "T",
      actions: [{ label: "Do it", command: "not.registered" }],
    })
    expect(notifyMock.mock.calls[0][0]).not.toHaveProperty("actions")
  })

  it("reports what the fan-out actually did rather than what was requested", async () => {
    await putNotification(record({ deliveredVia: ["center"], count: 3 }))
    const out = (await run("action.notify.send", { title: "T" })).output as Record<string, unknown>
    expect(out).toMatchObject({ notificationId: "n1", deliveredVia: ["center"], count: 3 })
  })

  it("survives a record it cannot read back", async () => {
    notifyMock.mockResolvedValue("missing")
    const out = (await run("action.notify.send", { title: "T" })).output as Record<string, unknown>
    expect(out).toMatchObject({ deliveredVia: [], count: 1 })
  })

  it("requires a title", async () => {
    await expect(run("action.notify.send", {})).rejects.toThrow(/requires 'title'/)
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it("falls back to info for an unknown level rather than passing it through", async () => {
    await putNotification(record())
    await run("action.notify.send", { title: "T", level: "catastrophic" })
    expect(notifyMock.mock.calls[0][0]).toMatchObject({ level: "info" })
  })
})

describe("action.notify.list", () => {
  it("projects rows and returns the badge counts", async () => {
    await putNotification(record({ id: "a", directed: true, createdAt: 2 }))
    await putNotification(record({ id: "b", readState: "read", createdAt: 1 }))
    const out = (await run("action.notify.list", {})).output as Record<string, unknown>
    expect(out.notificationCount).toBe(2)
    expect(out).toMatchObject({ directedUnread: 1, ambientUnseen: 1 })
    // Neither the author's `actions` nor the fan-out diagnostics mean anything
    // downstream, so neither is carried.
    expect(out.notifications).toEqual([
      expect.not.objectContaining({ deliveredVia: expect.anything() }),
      expect.not.objectContaining({ deliveredVia: expect.anything() }),
    ])
  })

  it("hides snoozed rows by default and shows them when asked", async () => {
    await putNotification(record({ id: "a", snoozedUntil: Date.now() + 60_000 }))
    const hidden = (await run("action.notify.list", {})).output as { notificationCount: number }
    expect(hidden.notificationCount).toBe(0)
    const shown = (await run("action.notify.list", { hideSnoozed: false })).output as {
      notificationCount: number
    }
    expect(shown.notificationCount).toBe(1)
  })

  it("filters by source", async () => {
    await putNotification(record({ id: "a", source: "workflow" }))
    await putNotification(record({ id: "b", source: "scheduler" }))
    const out = (await run("action.notify.list", { source: "scheduler" })).output as {
      notifications: Array<{ id: string }>
    }
    expect(out.notifications.map((n) => n.id)).toEqual(["b"])
  })
})

describe("action.notify.resolve", () => {
  it("cascades so read implies seen", async () => {
    await putNotification(record({ readState: "unseen" }))
    const out = (await run("action.notify.resolve", { notificationId: "n1", state: "read" }))
      .output as Record<string, unknown>
    expect(out).toMatchObject({ readState: "read", changed: true })
    const stored = await getNotification("n1")
    expect(stored?.readState).toBe("read")
    expect(stored?.firstSeenAt).toBeDefined()
    expect(stored?.lastReadAt).toBeDefined()
  })

  it("never walks the lifecycle backwards", async () => {
    await putNotification(record({ readState: "done", doneAt: 5, firstSeenAt: 1 }))
    const out = (await run("action.notify.resolve", { notificationId: "n1", state: "seen" }))
      .output as Record<string, unknown>
    expect(out).toMatchObject({ readState: "done", changed: false })
  })

  it("snoozes instead of changing the read state when a duration is given", async () => {
    await putNotification(record({ readState: "unseen" }))
    const out = (await run("action.notify.resolve", { notificationId: "n1", snoozeMs: 60_000 }))
      .output as Record<string, unknown>
    expect(out).toMatchObject({ readState: "unseen" })
    expect(out.snoozedUntil).toBeGreaterThan(Date.now())
    expect((await getNotification("n1"))?.readState).toBe("unseen")
  })

  it("refuses unseen as a target, and an unknown id, by name", async () => {
    await putNotification(record())
    await expect(
      run("action.notify.resolve", { notificationId: "n1", state: "unseen" })
    ).rejects.toThrow(/only moves forward/)
    await expect(run("action.notify.resolve", { notificationId: "nope" })).rejects.toThrow(
      /no notification nope/
    )
  })
})
