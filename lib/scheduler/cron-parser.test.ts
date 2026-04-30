/**
 * Cron Parser Tests
 */

import {
  parseCronExpression,
  validateCronExpression,
  getNextCronTime,
  getNextCronTimes,
  describeCronExpression,
  matchesCronExpression,
} from "./cron-parser"

describe("Cron Parser", () => {
  describe("parseCronExpression", () => {
    it("should parse valid 5-field cron expression", () => {
      const result = parseCronExpression("0 9 * * 1")
      expect(result).toEqual({
        minute: "0",
        hour: "9",
        dayOfMonth: "*",
        month: "*",
        dayOfWeek: "1",
      })
    })

    it("should return null for invalid format", () => {
      expect(parseCronExpression("0 9 * *")).toBeNull() // 4 fields
      expect(parseCronExpression("0 9 * * * *")).toBeNull() // 6 fields
      expect(parseCronExpression("")).toBeNull()
    })

    it("should handle expressions with multiple spaces", () => {
      const result = parseCronExpression("  0  9  *  *  1  ")
      expect(result).toEqual({
        minute: "0",
        hour: "9",
        dayOfMonth: "*",
        month: "*",
        dayOfWeek: "1",
      })
    })
  })

  describe("validateCronExpression", () => {
    it("should validate correct expressions", () => {
      expect(validateCronExpression("* * * * *").valid).toBe(true)
      expect(validateCronExpression("0 9 * * 1").valid).toBe(true)
      expect(validateCronExpression("*/5 * * * *").valid).toBe(true)
      expect(validateCronExpression("0 9 1-15 * *").valid).toBe(true)
      expect(validateCronExpression("0,30 * * * *").valid).toBe(true)
      expect(validateCronExpression("0 9 * * 1-5").valid).toBe(true)
    })

    it("should reject invalid expressions", () => {
      expect(validateCronExpression("60 * * * *").valid).toBe(false) // minute > 59
      expect(validateCronExpression("* 24 * * *").valid).toBe(false) // hour > 23
      expect(validateCronExpression("* * 32 * *").valid).toBe(false) // day > 31
      expect(validateCronExpression("* * * 13 *").valid).toBe(false) // month > 12
      expect(validateCronExpression("* * * * 7").valid).toBe(false) // dayOfWeek > 6
    })

    it("should validate step expressions", () => {
      expect(validateCronExpression("*/5 * * * *").valid).toBe(true)
      expect(validateCronExpression("0-30/5 * * * *").valid).toBe(true)
      expect(validateCronExpression("*/0 * * * *").valid).toBe(false) // step 0 invalid
    })

    it("should validate range expressions", () => {
      expect(validateCronExpression("0-30 * * * *").valid).toBe(true)
      expect(validateCronExpression("30-0 * * * *").valid).toBe(false) // start > end
    })
  })

  describe("getNextCronTime", () => {
    it("should calculate next run time for simple expressions", () => {
      const baseDate = new Date("2024-01-15T08:30:00")

      // Every hour at minute 0
      const next = getNextCronTime("0 * * * *", baseDate)
      expect(next).not.toBeNull()
      expect(next!.getMinutes()).toBe(0)
      expect(next!.getHours()).toBe(9)
    })

    it("should calculate next run time for daily expressions", () => {
      const baseDate = new Date("2024-01-15T10:00:00")

      // Daily at 9am
      const next = getNextCronTime("0 9 * * *", baseDate)
      expect(next).not.toBeNull()
      expect(next!.getHours()).toBe(9)
      expect(next!.getMinutes()).toBe(0)
      // Should be next day since we're past 9am
      expect(next!.getDate()).toBe(16)
    })

    it("should handle day of week expressions", () => {
      const baseDate = new Date("2024-01-15T08:00:00") // Monday

      // Every Friday at 9am
      const next = getNextCronTime("0 9 * * 5", baseDate)
      expect(next).not.toBeNull()
      expect(next!.getDay()).toBe(5) // Friday
    })

    it("should handle step expressions", () => {
      const baseDate = new Date("2024-01-15T08:32:00")

      // Every 15 minutes
      const next = getNextCronTime("*/15 * * * *", baseDate)
      expect(next).not.toBeNull()
      expect([0, 15, 30, 45]).toContain(next!.getMinutes())
    })

    it("should return null for invalid expressions", () => {
      expect(getNextCronTime("invalid")).toBeNull()
    })
  })

  describe("getNextCronTimes", () => {
    it("should return multiple upcoming times", () => {
      const baseDate = new Date("2024-01-15T08:00:00")
      const times = getNextCronTimes("0 * * * *", 5, baseDate)

      expect(times.length).toBe(5)
      for (const time of times) {
        expect(time.getMinutes()).toBe(0)
      }
    })

    it("should return empty array for invalid expressions", () => {
      expect(getNextCronTimes("invalid", 5)).toEqual([])
    })
  })

  describe("describeCronExpression", () => {
    it("should describe common expressions", () => {
      expect(describeCronExpression("* * * * *")).toContain("every minute")
      expect(describeCronExpression("*/5 * * * *")).toContain("5 minutes")
      expect(describeCronExpression("0 * * * *")).toContain("hour")
      expect(describeCronExpression("0 9 * * 1-5")).toContain("weekdays")
    })

    it("should return error for invalid expressions", () => {
      expect(describeCronExpression("invalid")).toBe("Invalid expression")
    })
  })

  describe("matchesCronExpression", () => {
    it("should match wildcard expression", () => {
      const date = new Date("2024-01-15T09:30:00")
      expect(matchesCronExpression("* * * * *", date)).toBe(true)
    })

    it("should match specific time", () => {
      const date = new Date("2024-01-15T09:30:00")
      expect(matchesCronExpression("30 9 * * *", date)).toBe(true)
      expect(matchesCronExpression("0 9 * * *", date)).toBe(false)
    })

    it("should match day of week", () => {
      const monday = new Date("2024-01-15T09:00:00") // Monday
      expect(matchesCronExpression("0 9 * * 1", monday)).toBe(true)
      expect(matchesCronExpression("0 9 * * 5", monday)).toBe(false)
    })

    it("should return false for invalid expressions", () => {
      expect(matchesCronExpression("invalid", new Date())).toBe(false)
    })
  })
})
