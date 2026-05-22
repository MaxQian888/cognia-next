import { cn, formatVideoTime, formatDurationShort, isTauri, responsiveSelectClass } from "./index"

describe("cn", () => {
  it("merges tailwind classes and resolves conflicts", () => {
    expect(cn("px-2", "px-4", "text-sm", "font-medium")).toBe("px-4 text-sm font-medium")
  })

  it("handles conditional values", () => {
    expect(
      cn("base", {
        active: true,
        disabled: false,
      })
    ).toBe("base active")
  })
})

describe("formatVideoTime", () => {
  it("returns 0:00 for non-finite or negative inputs", () => {
    expect(formatVideoTime(Number.NaN)).toBe("0:00")
    expect(formatVideoTime(Number.POSITIVE_INFINITY)).toBe("0:00")
    expect(formatVideoTime(-1)).toBe("0:00")
  })

  it("formats sub-minute durations with zero-padded seconds", () => {
    expect(formatVideoTime(0)).toBe("0:00")
    expect(formatVideoTime(7)).toBe("0:07")
    expect(formatVideoTime(59)).toBe("0:59")
  })

  it("formats minute+ durations as M:SS", () => {
    expect(formatVideoTime(60)).toBe("1:00")
    expect(formatVideoTime(125)).toBe("2:05")
    expect(formatVideoTime(3661)).toBe("61:01")
  })
})

describe("formatDurationShort", () => {
  it("returns '—' for null / undefined / non-finite / negative input", () => {
    expect(formatDurationShort(null)).toBe("—")
    expect(formatDurationShort(undefined)).toBe("—")
    expect(formatDurationShort(Number.NaN)).toBe("—")
    expect(formatDurationShort(Number.POSITIVE_INFINITY)).toBe("—")
    expect(formatDurationShort(-50)).toBe("—")
  })

  it("formats sub-second durations as integer ms", () => {
    expect(formatDurationShort(0)).toBe("0ms")
    expect(formatDurationShort(350)).toBe("350ms")
    expect(formatDurationShort(999.4)).toBe("999ms")
  })

  it("formats sub-minute durations with one decimal under 10s, integer above", () => {
    expect(formatDurationShort(1500)).toBe("1.5s")
    expect(formatDurationShort(9999)).toBe("10.0s") // 9.9995 rounds to 10.0
    expect(formatDurationShort(15_000)).toBe("15s")
    expect(formatDurationShort(59_999)).toBe("60s")
  })

  it("formats minute durations as 'Xm Ys' under one hour", () => {
    expect(formatDurationShort(60_000)).toBe("1m 0s")
    expect(formatDurationShort(72_000)).toBe("1m 12s")
    expect(formatDurationShort(59 * 60_000 + 30_000)).toBe("59m 30s")
  })

  it("formats hour-or-longer durations as 'Xh Ym'", () => {
    expect(formatDurationShort(3_600_000)).toBe("1h 0m")
    expect(formatDurationShort(3_600_000 + 12 * 60_000)).toBe("1h 12m")
    expect(formatDurationShort(3 * 3_600_000 + 45 * 60_000)).toBe("3h 45m")
  })
})

describe("isTauri re-export", () => {
  it("re-exports the same function from ../tauri", () => {
    expect(typeof isTauri).toBe("function")
    // In jsdom without window.__TAURI_INTERNALS__ this is always false.
    expect(isTauri()).toBe(false)
  })
})

describe("responsiveSelectClass", () => {
  it("starts mobile-full and locks at 16rem on sm+", () => {
    expect(responsiveSelectClass).toBe("w-full sm:w-64")
  })
  it("plays nicely with cn() — extra classes win conflicts via twMerge", () => {
    expect(cn(responsiveSelectClass, "h-7")).toBe("w-full sm:w-64 h-7")
    expect(cn(responsiveSelectClass, "w-32")).toBe("sm:w-64 w-32")
  })
})
