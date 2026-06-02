import { snoozeUntil, isSnoozed, selectAutoWake, SNOOZE_PRESETS_MS } from "./snooze"
import type { NotificationRecord } from "@/types/notifications"

function rec(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "n",
    source: "connector",
    level: "info",
    title: "t",
    createdAt: 0,
    updatedAt: 0,
    readState: "unseen",
    count: 1,
    directed: false,
    deliveredVia: ["center"],
    ...over,
  }
}

describe("snoozeUntil", () => {
  it("adds the duration to now", () => {
    expect(snoozeUntil(1000, SNOOZE_PRESETS_MS["15m"])).toBe(1000 + 15 * 60 * 1000)
  })
  it("clamps negative durations to now", () => {
    expect(snoozeUntil(1000, -50)).toBe(1000)
  })
})

describe("isSnoozed", () => {
  it("true while snoozedUntil is in the future", () => {
    expect(isSnoozed({ snoozedUntil: 2000 }, 1000)).toBe(true)
  })
  it("false once the snooze elapses or is unset", () => {
    expect(isSnoozed({ snoozedUntil: 500 }, 1000)).toBe(false)
    expect(isSnoozed({ snoozedUntil: undefined }, 1000)).toBe(false)
  })
})

describe("selectAutoWake", () => {
  const group = [
    rec({ id: "a", snoozedUntil: 9999 }),
    rec({ id: "b", snoozedUntil: 100 }), // already elapsed
    rec({ id: "c" }), // not snoozed
  ]

  it("returns currently-snoozed records when the preference is on", () => {
    const woken = selectAutoWake(group, 1000, { snoozeAutoWakeOnActivity: true })
    expect(woken.map((r) => r.id)).toEqual(["a"])
  })

  it("returns nothing when the preference is off", () => {
    expect(selectAutoWake(group, 1000, { snoozeAutoWakeOnActivity: false })).toEqual([])
  })
})
