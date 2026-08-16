import { DOCS_TIME_ZONE, formatDocsDate } from "./time-zone"

/**
 * Runs `fn` with `process.env.TZ` overridden, clearing the Intl format cache
 * either side so `Intl.DateTimeFormat` actually re-reads the zone.
 */
function withHostTimeZone<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ
  process.env.TZ = tz
  try {
    return fn()
  } finally {
    process.env.TZ = previous
  }
}

const LATE_UTC = "2026-07-22T23:30:00Z"

describe("DOCS_TIME_ZONE", () => {
  it("pins a fixed zone rather than deferring to the build machine", () => {
    expect(DOCS_TIME_ZONE).toBe("UTC")
  })
})

describe("formatDocsDate", () => {
  it("formats an ISO timestamp per docs locale", () => {
    expect(formatDocsDate("2026-07-22T10:00:00Z", "en")).toBe("Jul 22, 2026")
    expect(formatDocsDate("2026-07-22T10:00:00Z", "zh")).toBe("2026年7月22日")
  })

  it("falls back to the English form for a locale-shared page", () => {
    expect(formatDocsDate("2026-07-22T10:00:00Z", null)).toBe("Jul 22, 2026")
  })

  it("resolves the calendar day in UTC, not the host zone", () => {
    // 23:30 UTC is already the 23rd in Shanghai and still the 22nd in New York.
    // An unpinned `toLocaleDateString()` disagreed with itself across hosts.
    const shanghai = withHostTimeZone("Asia/Shanghai", () => formatDocsDate(LATE_UTC, "en"))
    const newYork = withHostTimeZone("America/New_York", () => formatDocsDate(LATE_UTC, "en"))

    expect(shanghai).toBe("Jul 22, 2026")
    expect(newYork).toBe("Jul 22, 2026")
  })

  it("ignores the host locale so the same commit renders identical markup", () => {
    // `Intl.DateTimeFormat` with an explicit tag never consults LANG/LC_ALL,
    // which is exactly the guarantee the argless `toLocaleDateString()` lacked.
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: DOCS_TIME_ZONE,
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(LATE_UTC))

    expect(formatDocsDate(LATE_UTC, "en")).toBe(formatted)
  })

  it("returns null for an unparseable value instead of throwing the prerender", () => {
    expect(formatDocsDate("not-a-date", "en")).toBeNull()
    expect(formatDocsDate("", "zh")).toBeNull()
  })
})
