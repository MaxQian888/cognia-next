import {
  latestElapsedSlot,
  scheduledBotTickRecordId,
  scheduledOccurrenceExecutionId,
} from "./occurrence"

const SLOT = new Date("2026-10-12T09:00:00.000Z")

describe("scheduledOccurrenceExecutionId", () => {
  it("names a slot's automatic fire the same way whenever it fires", () => {
    const onTime = scheduledOccurrenceExecutionId({
      taskId: "task_1",
      triggerSource: "schedule",
      scheduledFor: SLOT,
    })
    const caughtUp = scheduledOccurrenceExecutionId({
      taskId: "task_1",
      triggerSource: "catch-up",
      scheduledFor: new Date(SLOT.getTime() + 400),
    })
    expect(onTime).toBe(`occ-task_1-${SLOT.getTime()}`)
    expect(caughtUp).toBe(onTime)
    // Usable as a directory name.
    expect(onTime).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("keeps two slots and two tasks apart", () => {
    const base = { taskId: "task_1", triggerSource: "schedule" as const, scheduledFor: SLOT }
    expect(
      scheduledOccurrenceExecutionId({ ...base, scheduledFor: new Date(SLOT.getTime() + 60_000) })
    ).not.toBe(scheduledOccurrenceExecutionId(base))
    expect(scheduledOccurrenceExecutionId({ ...base, taskId: "task_2" })).not.toBe(
      scheduledOccurrenceExecutionId(base)
    )
  })

  it("leaves a start somebody asked for unkeyed", () => {
    for (const triggerSource of ["run-now", "retry", "event", "dependency", "remote", "backfill"]) {
      expect(
        scheduledOccurrenceExecutionId({
          taskId: "task_1",
          triggerSource: triggerSource as never,
          scheduledFor: SLOT,
        })
      ).toBeUndefined()
    }
    expect(
      scheduledOccurrenceExecutionId({ taskId: "task_1", triggerSource: "schedule" })
    ).toBeUndefined()
  })
})

describe("latestElapsedSlot", () => {
  const hourly = (after: Date) => new Date(after.getTime() + 3_600_000)

  it("is the persisted slot when the wake came just after it", () => {
    const now = new Date(SLOT.getTime() + 90_000)
    expect(latestElapsedSlot({ nextRunAt: SLOT, now, next: hourly })).toEqual(SLOT)
  })

  it("is the last elapsed slot after a long sleep, the same on every later wake", () => {
    const at = (ms: number) =>
      latestElapsedSlot({ nextRunAt: SLOT, now: new Date(ms), next: hourly })
    const lastElapsed = new Date(SLOT.getTime() + 3 * 3_600_000)
    expect(at(SLOT.getTime() + 3 * 3_600_000 + 5_000)).toEqual(lastElapsed)
    expect(at(SLOT.getTime() + 3 * 3_600_000 + 50 * 60_000)).toEqual(lastElapsed)
  })

  it("has no slot for an early wake or an unscheduled task", () => {
    expect(
      latestElapsedSlot({ nextRunAt: SLOT, now: new Date(SLOT.getTime() - 1), next: hourly })
    ).toBeUndefined()
    expect(latestElapsedSlot({ nextRunAt: undefined, now: SLOT, next: hourly })).toBeUndefined()
  })

  it("stops at a schedule with no further slot, or one that does not advance", () => {
    const now = new Date(SLOT.getTime() + 10 * 3_600_000)
    expect(latestElapsedSlot({ nextRunAt: SLOT, now, next: () => undefined })).toEqual(SLOT)
    expect(latestElapsedSlot({ nextRunAt: SLOT, now, next: (after) => after })).toEqual(SLOT)
  })
})

describe("scheduledBotTickRecordId", () => {
  const oneOff = jest.fn((prefix: string) => `${prefix}_random`)

  it("keys a timed tick on its slot, so firing it again lands on the same delivery", () => {
    const base = { installationId: "inst", triggerId: "trg", oneOff }
    const first = scheduledBotTickRecordId({
      ...base,
      triggerSource: "schedule",
      scheduledFor: SLOT,
    })
    // The same slot reached again, by the catch-up path.
    const caughtUp = scheduledBotTickRecordId({
      ...base,
      triggerSource: "catch-up",
      scheduledFor: SLOT,
    })
    expect(first).toBe(`inst-trg@${SLOT.getTime()}`)
    expect(caughtUp).toBe(first)
    const nextSlot = scheduledBotTickRecordId({
      ...base,
      triggerSource: "schedule",
      scheduledFor: new Date(SLOT.getTime() + 60_000),
    })
    expect(nextSlot).not.toBe(first)
  })

  it("makes a tick started by hand, or a retry, its own event", () => {
    expect(
      scheduledBotTickRecordId({
        installationId: "inst",
        triggerId: "trg",
        triggerSource: "retry",
        scheduledFor: SLOT,
        oneOff,
      })
    ).toBe("inst-trg_random")
    expect(
      scheduledBotTickRecordId({
        installationId: "inst",
        triggerId: "trg",
        triggerSource: "run-now",
        scheduledFor: SLOT,
        oneOff,
      })
    ).toBe("inst-trg_random")
    expect(
      scheduledBotTickRecordId({
        installationId: "inst",
        triggerId: "trg",
        triggerSource: "schedule",
        oneOff,
      })
    ).toBe("inst-trg_random")
  })
})
