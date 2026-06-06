import { normalizeTaskTrigger, isValidTimezone } from "./trigger-normalizer"
import { SchedulerError } from "./errors"

describe("trigger-normalizer", () => {
  describe("isValidTimezone", () => {
    it("returns true for valid IANA timezone", () => {
      expect(isValidTimezone("UTC")).toBe(true)
      expect(isValidTimezone("Asia/Shanghai")).toBe(true)
    })

    it("returns false for invalid timezone", () => {
      expect(isValidTimezone("Not/A-Timezone")).toBe(false)
    })
  })

  describe("normalizeTaskTrigger", () => {
    it("normalizes valid cron trigger", () => {
      const trigger = normalizeTaskTrigger({
        type: "cron",
        cronExpression: " 0 9 * * * ",
        timezone: "UTC",
        dependsOn: ["a", "b", "a"],
      })

      expect(trigger).toEqual({
        type: "cron",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        dependsOn: ["a", "b"],
      })
    })

    it("floors and keeps positive jitterMs on cron and interval triggers", () => {
      expect(
        normalizeTaskTrigger({ type: "cron", cronExpression: "0 9 * * *", jitterMs: 1500.9 })
          .jitterMs
      ).toBe(1500)
      expect(
        normalizeTaskTrigger({ type: "interval", intervalMs: 60000, jitterMs: 250 }).jitterMs
      ).toBe(250)
    })

    it("drops zero, negative, or invalid jitterMs", () => {
      expect(
        normalizeTaskTrigger({ type: "interval", intervalMs: 60000, jitterMs: 0 }).jitterMs
      ).toBeUndefined()
      expect(
        normalizeTaskTrigger({ type: "interval", intervalMs: 60000, jitterMs: -5 }).jitterMs
      ).toBeUndefined()
      expect(
        normalizeTaskTrigger({
          type: "interval",
          intervalMs: 60000,
          jitterMs: Number.NaN,
        }).jitterMs
      ).toBeUndefined()
    })

    it("throws for invalid cron expression", () => {
      expect(() =>
        normalizeTaskTrigger({
          type: "cron",
          cronExpression: "invalid-cron",
        })
      ).toThrow(SchedulerError)
    })

    it("throws for invalid timezone", () => {
      expect(() =>
        normalizeTaskTrigger({
          type: "cron",
          cronExpression: "0 9 * * *",
          timezone: "Not/A-Timezone",
        })
      ).toThrow(SchedulerError)
    })

    it("normalizes interval trigger and floors interval", () => {
      const trigger = normalizeTaskTrigger({
        type: "interval",
        intervalMs: 60000.7,
      })

      expect(trigger).toEqual({
        type: "interval",
        intervalMs: 60000,
        dependsOn: undefined,
      })
    })

    it("throws for non-positive interval trigger", () => {
      expect(() =>
        normalizeTaskTrigger({
          type: "interval",
          intervalMs: 0,
        })
      ).toThrow(SchedulerError)
    })

    it("normalizes valid one-time trigger", () => {
      const future = new Date(Date.now() + 5 * 60_000)
      const trigger = normalizeTaskTrigger({
        type: "once",
        runAt: future,
      })

      expect(trigger.type).toBe("once")
      expect(trigger.runAt).toEqual(future)
    })

    it("throws when one-time runAt is in the past", () => {
      const past = new Date(Date.now() - 60_000)
      expect(() =>
        normalizeTaskTrigger({
          type: "once",
          runAt: past,
        })
      ).toThrow(SchedulerError)
    })

    it("normalizes event trigger", () => {
      const trigger = normalizeTaskTrigger({
        type: "event",
        eventType: " workflow.completed ",
        eventSource: " system ",
      })

      expect(trigger).toEqual({
        type: "event",
        eventType: "workflow.completed",
        eventSource: "system",
        dependsOn: undefined,
      })
    })

    it("throws for missing event type", () => {
      expect(() =>
        normalizeTaskTrigger({
          type: "event",
          eventType: "  ",
        })
      ).toThrow(SchedulerError)
    })
  })
})
