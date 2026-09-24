import {
  notifyScheduledDue,
  scheduledDueDedupeKey,
  SCHEDULED_DUE_GROUP_KEY,
} from "./notify-scheduled-due"

jest.mock("@/lib/notifications/runtime", () => ({
  notify: jest.fn().mockResolvedValue("rec-id"),
}))

describe("notifyScheduledDue", () => {
  beforeEach(() => jest.clearAllMocks())

  it("posts a directed reminder to center+toast+os with a per-task dedupe key", async () => {
    const notify = jest.fn().mockResolvedValue("id1")
    const ok = await notifyScheduledDue("t1", { title: "Due", body: "Backup is due" }, { notify })

    expect(ok).toBe(true)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "system",
        level: "info",
        title: "Due",
        body: "Backup is due",
        channels: ["center", "toast", "os"],
        dedupeKey: "pet-scheduled-due:t1",
        coalesceWindowMs: Number.POSITIVE_INFINITY,
        groupKey: SCHEDULED_DUE_GROUP_KEY,
        sourceRef: { kind: "task", id: "t1" },
        icon: "Clock",
        directed: true,
      })
    )
  })

  it("passes meta/actions/href through to the record", async () => {
    const notify = jest.fn().mockResolvedValue("id2")
    const meta = { scheduledDue: { taskId: "t1", name: "Backup" } }
    const actions = [
      { id: "open", label: "Open", command: "scheduler.open-task", args: { taskId: "t1" } },
    ]
    const ok = await notifyScheduledDue(
      "t1",
      { title: "Due", meta, actions, href: "/scheduler?item=app%3At1" },
      { notify }
    )

    expect(ok).toBe(true)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ meta, actions, href: "/scheduler?item=app%3At1" })
    )
  })

  it("omits optional fields when not supplied", async () => {
    const notify = jest.fn().mockResolvedValue("id3")
    await notifyScheduledDue("t1", { title: "Due" }, { notify })
    const input = notify.mock.calls[0][0]
    expect(input.meta).toBeUndefined()
    expect(input.actions).toBeUndefined()
    expect(input.href).toBeUndefined()
  })

  it("falls back to the runtime notify when none is injected", async () => {
    const { notify } = jest.requireMock("@/lib/notifications/runtime")
    const ok = await notifyScheduledDue("t2", { title: "Due" })
    expect(ok).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it("returns false and never throws when notify rejects", async () => {
    const notify = jest.fn().mockRejectedValue(new Error("boom"))
    await expect(notifyScheduledDue("t1", { title: "x" }, { notify })).resolves.toBe(false)
  })

  it("derives a stable per-task dedupe key", () => {
    expect(scheduledDueDedupeKey("abc")).toBe("pet-scheduled-due:abc")
  })
})
