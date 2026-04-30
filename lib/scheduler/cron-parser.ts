/**
 * Cron Expression Parser
 * Parses and validates cron expressions, calculates next run times
 */

import type { CronParts } from "@/types/scheduler"

// Field constraints
const FIELD_CONSTRAINTS = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 6 }, // 0 = Sunday
}

// Month names for parsing
const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

// Day names for parsing
const DAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

/**
 * Parse a cron expression into its parts
 */
export function parseCronExpression(expression: string): CronParts | null {
  const parts = expression.trim().split(/\s+/)

  if (parts.length !== 5) {
    return null
  }

  return {
    minute: parts[0],
    hour: parts[1],
    dayOfMonth: parts[2],
    month: parts[3],
    dayOfWeek: parts[4],
  }
}

/**
 * Validate a cron expression
 */
export function validateCronExpression(expression: string): { valid: boolean; error?: string } {
  const parts = parseCronExpression(expression)

  if (!parts) {
    return {
      valid: false,
      error: "Invalid format. Expected 5 fields: minute hour dayOfMonth month dayOfWeek",
    }
  }

  // Validate each field
  const validations: Array<{ field: keyof CronParts; name: string }> = [
    { field: "minute", name: "minute" },
    { field: "hour", name: "hour" },
    { field: "dayOfMonth", name: "day of month" },
    { field: "month", name: "month" },
    { field: "dayOfWeek", name: "day of week" },
  ]

  for (const { field, name } of validations) {
    const result = validateField(parts[field], field)
    if (!result.valid) {
      return { valid: false, error: `Invalid ${name}: ${result.error}` }
    }
  }

  return { valid: true }
}

/**
 * Validate a single cron field
 */
function validateField(
  value: string,
  field: keyof typeof FIELD_CONSTRAINTS
): { valid: boolean; error?: string } {
  const constraints = FIELD_CONSTRAINTS[field]

  // Handle wildcard
  if (value === "*") {
    return { valid: true }
  }

  // Handle step values (e.g., */5, 1-10/2)
  const stepMatch = value.match(/^(.+)\/(\d+)$/)
  if (stepMatch) {
    const [, base, step] = stepMatch
    const stepNum = parseInt(step, 10)
    if (isNaN(stepNum) || stepNum < 1) {
      return { valid: false, error: `Invalid step value: ${step}` }
    }
    // Validate the base part
    if (base !== "*") {
      return validateField(base, field)
    }
    return { valid: true }
  }

  // Handle ranges (e.g., 1-5)
  const rangeMatch = value.match(/^(\d+)-(\d+)$/)
  if (rangeMatch) {
    const [, start, end] = rangeMatch
    const startNum = parseInt(start, 10)
    const endNum = parseInt(end, 10)

    if (isNaN(startNum) || isNaN(endNum)) {
      return { valid: false, error: "Invalid range values" }
    }
    if (startNum > endNum) {
      return { valid: false, error: "Range start must be less than end" }
    }
    if (startNum < constraints.min || endNum > constraints.max) {
      return {
        valid: false,
        error: `Values must be between ${constraints.min} and ${constraints.max}`,
      }
    }
    return { valid: true }
  }

  // Handle lists (e.g., 1,3,5)
  if (value.includes(",")) {
    const items = value.split(",")
    for (const item of items) {
      const result = validateField(item.trim(), field)
      if (!result.valid) {
        return result
      }
    }
    return { valid: true }
  }

  // Handle single values (including named values for month/day)
  let numValue: number

  if (field === "month" && MONTH_NAMES[value.toLowerCase()]) {
    numValue = MONTH_NAMES[value.toLowerCase()]
  } else if (field === "dayOfWeek" && DAY_NAMES[value.toLowerCase()]) {
    numValue = DAY_NAMES[value.toLowerCase()]
  } else {
    numValue = parseInt(value, 10)
  }

  if (isNaN(numValue)) {
    return { valid: false, error: `Invalid value: ${value}` }
  }

  if (numValue < constraints.min || numValue > constraints.max) {
    return {
      valid: false,
      error: `Value must be between ${constraints.min} and ${constraints.max}`,
    }
  }

  return { valid: true }
}

/**
 * Parse a field value into an array of valid values
 */
function parseFieldValues(value: string, field: keyof typeof FIELD_CONSTRAINTS): number[] {
  const constraints = FIELD_CONSTRAINTS[field]
  const values: Set<number> = new Set()

  // Handle step values
  const stepMatch = value.match(/^(.+)\/(\d+)$/)
  if (stepMatch) {
    const [, base, step] = stepMatch
    const stepNum = parseInt(step, 10)

    let start = constraints.min
    let end = constraints.max

    if (base !== "*") {
      const rangeMatch = base.match(/^(\d+)-(\d+)$/)
      if (rangeMatch) {
        start = parseInt(rangeMatch[1], 10)
        end = parseInt(rangeMatch[2], 10)
      }
    }

    for (let i = start; i <= end; i += stepNum) {
      values.add(i)
    }
    return Array.from(values).sort((a, b) => a - b)
  }

  // Handle wildcard
  if (value === "*") {
    for (let i = constraints.min; i <= constraints.max; i++) {
      values.add(i)
    }
    return Array.from(values)
  }

  // Handle lists
  const items = value.split(",")
  for (const item of items) {
    // Handle ranges
    const rangeMatch = item.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10)
      const end = parseInt(rangeMatch[2], 10)
      for (let i = start; i <= end; i++) {
        values.add(i)
      }
      continue
    }

    // Handle single values
    let numValue: number
    if (field === "month" && MONTH_NAMES[item.toLowerCase()]) {
      numValue = MONTH_NAMES[item.toLowerCase()]
    } else if (field === "dayOfWeek" && DAY_NAMES[item.toLowerCase()]) {
      numValue = DAY_NAMES[item.toLowerCase()]
    } else {
      numValue = parseInt(item, 10)
    }

    if (!isNaN(numValue)) {
      values.add(numValue)
    }
  }

  return Array.from(values).sort((a, b) => a - b)
}

/**
 * Get date parts in a specific timezone using Intl API
 */
function getDatePartsInTimezone(
  date: Date,
  timezone: string
): { year: number; month: number; day: number; hour: number; minute: number; dayOfWeek: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  })

  const parts = formatter.formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value || ""

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }

  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
    dayOfWeek: weekdayMap[get("weekday")] ?? 0,
  }
}

/**
 * Get the next occurrence of a cron expression
 * @param timezone - Optional IANA timezone (e.g., 'America/New_York'). When set, cron matching
 *                   is done against the wall clock time in that timezone.
 */
export function getNextCronTime(
  expression: string,
  fromDate: Date = new Date(),
  timezone?: string
): Date | null {
  const parts = parseCronExpression(expression)
  if (!parts) return null

  const minutes = parseFieldValues(parts.minute, "minute")
  const hours = parseFieldValues(parts.hour, "hour")
  const daysOfMonth = parseFieldValues(parts.dayOfMonth, "dayOfMonth")
  const months = parseFieldValues(parts.month, "month")
  const daysOfWeek = parseFieldValues(parts.dayOfWeek, "dayOfWeek")

  // Use timezone-aware or local date accessors
  const useTz = !!timezone
  const getParts = (d: Date) =>
    useTz
      ? getDatePartsInTimezone(d, timezone!)
      : {
          year: d.getFullYear(),
          month: d.getMonth() + 1,
          day: d.getDate(),
          hour: d.getHours(),
          minute: d.getMinutes(),
          dayOfWeek: d.getDay(),
        }

  // Start from the next minute
  const current = new Date(fromDate)
  current.setSeconds(0)
  current.setMilliseconds(0)
  current.setMinutes(current.getMinutes() + 1)

  // Search up to 4 years ahead
  const maxDate = new Date(fromDate)
  maxDate.setFullYear(maxDate.getFullYear() + 4)

  while (current < maxDate) {
    const p = getParts(current)

    // Check month
    if (!months.includes(p.month)) {
      // Move to next valid month
      current.setMonth(current.getMonth() + 1)
      current.setDate(1)
      current.setHours(0)
      current.setMinutes(0)
      continue
    }

    // Check day of month and day of week
    const dayOfMonthValid = daysOfMonth.includes(p.day)
    const dayOfWeekValid = daysOfWeek.includes(p.dayOfWeek)

    // If both day restrictions are wildcards, both are valid
    // Otherwise, at least one must match
    const dayValid =
      (parts.dayOfMonth === "*" && parts.dayOfWeek === "*") ||
      (parts.dayOfMonth !== "*" && parts.dayOfWeek === "*" && dayOfMonthValid) ||
      (parts.dayOfMonth === "*" && parts.dayOfWeek !== "*" && dayOfWeekValid) ||
      (parts.dayOfMonth !== "*" && parts.dayOfWeek !== "*" && (dayOfMonthValid || dayOfWeekValid))

    if (!dayValid) {
      current.setDate(current.getDate() + 1)
      current.setHours(0)
      current.setMinutes(0)
      continue
    }

    // Check hour
    if (!hours.includes(p.hour)) {
      // Find next valid hour
      const nextHour = hours.find((h) => h > p.hour)
      if (nextHour !== undefined) {
        current.setHours(current.getHours() + (nextHour - p.hour))
        current.setMinutes(current.getMinutes() - p.minute + minutes[0])
      } else {
        // Move to next day
        current.setDate(current.getDate() + 1)
        current.setHours(0)
        current.setMinutes(0)
      }
      continue
    }

    // Check minute
    if (!minutes.includes(p.minute)) {
      // Find next valid minute
      const nextMinute = minutes.find((m) => m > p.minute)
      if (nextMinute !== undefined) {
        current.setMinutes(current.getMinutes() + (nextMinute - p.minute))
      } else {
        // Move to next hour
        current.setMinutes(0)
        current.setHours(current.getHours() + 1)
      }
      continue
    }

    // All conditions met
    return current
  }

  return null
}

/**
 * Get multiple upcoming occurrences of a cron expression
 */
export function getNextCronTimes(
  expression: string,
  count: number,
  fromDate: Date = new Date(),
  timezone?: string
): Date[] {
  const times: Date[] = []
  let current = fromDate

  for (let i = 0; i < count; i++) {
    const next = getNextCronTime(expression, current, timezone)
    if (!next) break
    times.push(next)
    current = next
  }

  return times
}

/**
 * Get a human-readable description of a cron expression
 */
export function describeCronExpression(expression: string): string {
  const parts = parseCronExpression(expression)
  if (!parts) return "Invalid expression"

  const descriptions: string[] = []

  // Minute
  if (parts.minute === "*") {
    descriptions.push("every minute")
  } else if (parts.minute.startsWith("*/")) {
    descriptions.push(`every ${parts.minute.slice(2)} minutes`)
  } else {
    descriptions.push(`at minute ${parts.minute}`)
  }

  // Hour
  if (parts.hour === "*") {
    descriptions.push("of every hour")
  } else if (parts.hour.startsWith("*/")) {
    descriptions.push(`every ${parts.hour.slice(2)} hours`)
  } else {
    descriptions.push(`at ${parts.hour}:00`)
  }

  // Day of month
  if (parts.dayOfMonth !== "*") {
    if (parts.dayOfMonth.startsWith("*/")) {
      descriptions.push(`every ${parts.dayOfMonth.slice(2)} days`)
    } else {
      descriptions.push(`on day ${parts.dayOfMonth}`)
    }
  }

  // Month
  if (parts.month !== "*") {
    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ]
    if (parts.month.startsWith("*/")) {
      descriptions.push(`every ${parts.month.slice(2)} months`)
    } else {
      const monthNum = parseInt(parts.month, 10)
      if (!isNaN(monthNum) && monthNum >= 1 && monthNum <= 12) {
        descriptions.push(`in ${monthNames[monthNum - 1]}`)
      }
    }
  }

  // Day of week
  if (parts.dayOfWeek !== "*") {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    if (parts.dayOfWeek === "1-5") {
      descriptions.push("on weekdays")
    } else if (parts.dayOfWeek === "0,6") {
      descriptions.push("on weekends")
    } else {
      const dayNum = parseInt(parts.dayOfWeek, 10)
      if (!isNaN(dayNum) && dayNum >= 0 && dayNum <= 6) {
        descriptions.push(`on ${dayNames[dayNum]}`)
      }
    }
  }

  return descriptions.join(" ")
}

/**
 * Format a cron expression for display
 */
export function formatCronExpression(parts: CronParts): string {
  return `${parts.minute} ${parts.hour} ${parts.dayOfMonth} ${parts.month} ${parts.dayOfWeek}`
}

/**
 * Check if a date matches a cron expression
 */
export function matchesCronExpression(expression: string, date: Date): boolean {
  const parts = parseCronExpression(expression)
  if (!parts) return false

  const minutes = parseFieldValues(parts.minute, "minute")
  const hours = parseFieldValues(parts.hour, "hour")
  const daysOfMonth = parseFieldValues(parts.dayOfMonth, "dayOfMonth")
  const months = parseFieldValues(parts.month, "month")
  const daysOfWeek = parseFieldValues(parts.dayOfWeek, "dayOfWeek")

  // Check all conditions
  if (!minutes.includes(date.getMinutes())) return false
  if (!hours.includes(date.getHours())) return false
  if (!months.includes(date.getMonth() + 1)) return false

  // Day matching (same logic as getNextCronTime)
  const dayOfMonth = date.getDate()
  const dayOfWeek = date.getDay()
  const dayOfMonthValid = daysOfMonth.includes(dayOfMonth)
  const dayOfWeekValid = daysOfWeek.includes(dayOfWeek)

  if (parts.dayOfMonth === "*" && parts.dayOfWeek === "*") return true
  if (parts.dayOfMonth !== "*" && parts.dayOfWeek === "*") return dayOfMonthValid
  if (parts.dayOfMonth === "*" && parts.dayOfWeek !== "*") return dayOfWeekValid
  return dayOfMonthValid || dayOfWeekValid
}
