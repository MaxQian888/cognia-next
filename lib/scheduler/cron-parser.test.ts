/**
 * Cron Parser Tests
 *
 * Covers the `cron-parser@5`-backed implementation: 5/6-field parsing, macros,
 * the OCPS modifiers `L`/`#`, timezone handling, the rejected `W` modifier, and
 * parity guarantees carried over from the previous hand-rolled parser
 * (DOM/DOW OR semantics, impossible-expression → null).
 */

import {
  parseCronExpression,
  validateCronExpression,
  getNextCronTime,
  getNextCronTimes,
  describeCronExpression,
  formatCronExpression,
  matchesCronExpression,
} from "./cron-parser"

/** Read the wall-clock hour of `date` in a given IANA zone. */
function hourInZone(date: Date, timeZone: string): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).format(date)
  return parseInt(s, 10) % 24
}

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
      expect(result?.seconds).toBeUndefined()
    })

    it("should parse a 6-field (seconds) expression", () => {
      const result = parseCronExpression("30 0 9 * * 1-5")
      expect(result).toEqual({
        seconds: "30",
        minute: "0",
        hour: "9",
        dayOfMonth: "*",
        month: "*",
        dayOfWeek: "1-5",
      })
    })

    it("should expand predefined macros", () => {
      expect(parseCronExpression("@daily")).toEqual({
        seconds: "0",
        minute: "0",
        hour: "0",
        dayOfMonth: "*",
        month: "*",
        dayOfWeek: "*",
      })
    })

    it("should return null for invalid format", () => {
      expect(parseCronExpression("0 9 * *")).toBeNull() // 4 fields
      expect(parseCronExpression("0 0 12 1 1 * 2026")).toBeNull() // 7 fields (year)
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

    it("should accept the new grammar (seconds, L, #, macros, 7=Sunday)", () => {
      expect(validateCronExpression("*/30 * * * * *").valid).toBe(true) // seconds
      expect(validateCronExpression("0 0 L * *").valid).toBe(true) // last day
      expect(validateCronExpression("0 0 * * 5#2").valid).toBe(true) // 2nd Friday
      expect(validateCronExpression("@daily").valid).toBe(true) // macro
      expect(validateCronExpression("* * * * 7").valid).toBe(true) // 7 = Sunday
    })

    it("should reject invalid expressions", () => {
      expect(validateCronExpression("60 * * * *").valid).toBe(false) // minute > 59
      expect(validateCronExpression("* 24 * * *").valid).toBe(false) // hour > 23
      expect(validateCronExpression("* * 32 * *").valid).toBe(false) // day > 31
      expect(validateCronExpression("* * * 13 *").valid).toBe(false) // month > 12
      expect(validateCronExpression("").valid).toBe(false)
    })

    it("should reject the unsupported W (nearest weekday) modifier", () => {
      const result = validateCronExpression("0 0 15W * *")
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/W/)
    })

    it("should reject 7-field (year) expressions", () => {
      const result = validateCronExpression("0 0 12 1 1 * 2026")
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/year/i)
    })
  })

  describe("getNextCronTime", () => {
    it("should calculate next run time for simple expressions", () => {
      const baseDate = new Date("2024-01-15T08:30:00")
      const next = getNextCronTime("0 * * * *", baseDate)
      expect(next).not.toBeNull()
      expect(next!.getMinutes()).toBe(0)
      expect(next!.getHours()).toBe(9)
    })

    it("should calculate next run time for daily expressions", () => {
      const baseDate = new Date("2024-01-15T10:00:00")
      const next = getNextCronTime("0 9 * * *", baseDate)
      expect(next).not.toBeNull()
      expect(next!.getHours()).toBe(9)
      expect(next!.getMinutes()).toBe(0)
      expect(next!.getDate()).toBe(16) // past 9am → next day
    })

    it("should handle day of week expressions", () => {
      const baseDate = new Date("2024-01-15T08:00:00") // Monday
      const next = getNextCronTime("0 9 * * 5", baseDate)
      expect(next).not.toBeNull()
      expect(next!.getDay()).toBe(5) // Friday
    })

    it("should handle step expressions", () => {
      const baseDate = new Date("2024-01-15T08:32:00")
      const next = getNextCronTime("*/15 * * * *", baseDate)
      expect(next).not.toBeNull()
      expect([0, 15, 30, 45]).toContain(next!.getMinutes())
    })

    it("should handle seconds-granular expressions", () => {
      const baseDate = new Date("2024-01-15T08:32:05")
      const next = getNextCronTime("*/30 * * * * *", baseDate)
      expect(next).not.toBeNull()
      expect([0, 30]).toContain(next!.getSeconds())
    })

    it("should honor an explicit timezone", () => {
      // 9am in New York, computed from a UTC anchor.
      const next = getNextCronTime(
        "0 9 * * *",
        new Date("2024-01-15T00:00:00Z"),
        "America/New_York"
      )
      expect(next).not.toBeNull()
      expect(hourInZone(next!, "America/New_York")).toBe(9)
    })

    it("should return null for invalid expressions", () => {
      expect(getNextCronTime("invalid")).toBeNull()
    })

    it("should return null for impossible expressions", () => {
      expect(getNextCronTime("0 0 30 2 *")).toBeNull() // Feb 30 never happens
    })

    it("should return null for the W modifier", () => {
      expect(getNextCronTime("0 0 15W * *")).toBeNull()
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
      // Strictly increasing.
      for (let i = 1; i < times.length; i++) {
        expect(times[i].getTime()).toBeGreaterThan(times[i - 1].getTime())
      }
    })

    it("should return empty array for invalid expressions or non-positive count", () => {
      expect(getNextCronTimes("invalid", 5)).toEqual([])
      expect(getNextCronTimes("0 * * * *", 0)).toEqual([])
    })
  })

  describe("describeCronExpression", () => {
    it("should describe common expressions in English by default", () => {
      expect(describeCronExpression("* * * * *")).toContain("every minute")
      expect(describeCronExpression("*/5 * * * *")).toContain("5 minutes")
      expect(describeCronExpression("0 * * * *")).toContain("hour")
      expect(describeCronExpression("0 9 * * 1-5")).toContain("weekdays")
      expect(describeCronExpression("0 0 0,6 * 0,6").length).toBeGreaterThan(0)
    })

    it("should describe new grammar tokens", () => {
      expect(describeCronExpression("0 0 L * *")).toContain("last day")
      expect(describeCronExpression("0 0 * * 5#2")).toMatch(/2.*Friday|Friday/)
      expect(describeCronExpression("0 0 * * 0,6")).toContain("weekends")
    })

    it("should use a translator when provided", () => {
      const t = (key: string) => `T:${key}`
      expect(describeCronExpression("* * * * *", t)).toContain("T:everyMinute")
      expect(describeCronExpression("invalid", t)).toBe("T:invalid")
    })

    it("should return error text for invalid expressions", () => {
      expect(describeCronExpression("invalid")).toBe("Invalid expression")
    })

    it("covers every field-shape branch via the English fallback", () => {
      const cases: Array<[string, string]> = [
        ["30 0 9 * * *", "at second 30"],
        ["*/30 0 9 * * *", "every 30 seconds"],
        ["0 */2 * * *", "every 2 hours"],
        ["0 9 * * *", "at 9:00"],
        ["0 0 */3 * *", "every 3 days"],
        ["0 0 15 * *", "on day 15"],
        ["0 0 L * *", "last day"],
        ["0 0 1 */2 *", "every 2 months"],
        ["0 0 1 6 *", "Jun"],
        ["0 0 * * 5#2", "occurrence"],
        ["0 0 * * 5L", "last Friday"],
        ["0 0 * * 3", "Wednesday"],
        ["0 0 * * 0,6", "weekends"],
      ]
      for (const [expr, expected] of cases) {
        expect(describeCronExpression(expr)).toContain(expected)
      }
    })

    it("keeps seconds=0/* out of the description", () => {
      // 6-field with seconds "0" should not add a seconds segment.
      expect(describeCronExpression("0 0 9 * * *")).not.toContain("second")
    })
  })

  describe("formatCronExpression", () => {
    it("should round-trip a 5-field expression byte-identically", () => {
      const parts = parseCronExpression("0 9 * * 1-5")
      expect(parts).not.toBeNull()
      expect(formatCronExpression(parts!)).toBe("0 9 * * 1-5")
    })

    it("should emit 6 fields when seconds are present", () => {
      const parts = parseCronExpression("30 0 9 * * 1")
      expect(formatCronExpression(parts!)).toBe("30 0 9 * * 1")
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

    it("should use OR/union semantics when both DOM and DOW are restricted", () => {
      // "0 0 13 * 5" → fires on the 13th OR on any Friday, at 00:00.
      expect(matchesCronExpression("0 0 13 * 5", new Date("2024-01-13T00:00:00"))).toBe(true) // Sat 13th (DOM)
      expect(matchesCronExpression("0 0 13 * 5", new Date("2024-01-05T00:00:00"))).toBe(true) // Fri 5th (DOW)
      expect(matchesCronExpression("0 0 13 * 5", new Date("2024-01-06T00:00:00"))).toBe(false) // Sat 6th (neither)
    })

    it("should return false for invalid expressions", () => {
      expect(matchesCronExpression("invalid", new Date())).toBe(false)
    })
  })
})
