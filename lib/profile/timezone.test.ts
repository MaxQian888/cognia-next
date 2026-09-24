import { deviceTimeZone, resolveFormattingTimeZone, resolveUserTimeZone } from "./timezone"

describe("deviceTimeZone", () => {
  it("returns a non-empty IANA-ish string", () => {
    const tz = deviceTimeZone()
    expect(typeof tz).toBe("string")
    expect(tz.length).toBeGreaterThan(0)
  })

  it("falls back to UTC when Intl throws", () => {
    const original = Intl.DateTimeFormat
    // @ts-expect-error — force the failure path
    Intl.DateTimeFormat = () => {
      throw new Error("no Intl")
    }
    try {
      expect(deviceTimeZone()).toBe("UTC")
    } finally {
      Intl.DateTimeFormat = original
    }
  })
})

describe("resolveUserTimeZone", () => {
  it("prefers an explicit profile timezone", () => {
    expect(resolveUserTimeZone({ timezone: "Asia/Tokyo" })).toBe("Asia/Tokyo")
  })

  it("trims and ignores blank overrides", () => {
    expect(resolveUserTimeZone({ timezone: "  Europe/Paris  " })).toBe("Europe/Paris")
    // A whitespace-only override is treated as unset → device zone.
    expect(resolveUserTimeZone({ timezone: "   " })).toBe(deviceTimeZone())
  })

  it("falls back to the device zone when unset, null, or undefined", () => {
    const device = deviceTimeZone()
    expect(resolveUserTimeZone(undefined)).toBe(device)
    expect(resolveUserTimeZone(null)).toBe(device)
    expect(resolveUserTimeZone({})).toBe(device)
  })
})

describe("resolveFormattingTimeZone", () => {
  it("uses a valid profile override, in the runtime's spelling", () => {
    expect(resolveFormattingTimeZone({ timezone: "Asia/Shanghai" })).toBe("Asia/Shanghai")
    expect(resolveFormattingTimeZone({ timezone: " UTC " })).toBe("UTC")
  })

  it("falls back to the device zone when there is no override", () => {
    expect(resolveFormattingTimeZone(undefined)).toBe(deviceTimeZone())
    expect(resolveFormattingTimeZone({ timezone: "" })).toBe(deviceTimeZone())
  })

  // An unknown zone makes every Intl.DateTimeFormat throw — one typo in the
  // profile must not take every formatted date in the app down with it.
  it("falls back to the device zone when the override is not a zone", () => {
    expect(resolveFormattingTimeZone({ timezone: "Not/AZone" })).toBe(deviceTimeZone())
  })
})
