import { relativeCompact } from "./relative-time"

const NOW = Date.UTC(2025, 0, 15, 12, 0, 0) // fixed render clock

describe("relativeCompact", () => {
  it("picks the largest whole unit", () => {
    const h4 = 4 * 60 * 60 * 1000
    expect(relativeCompact(NOW - h4, NOW, "en")).toBe("4h ago")
    expect(relativeCompact(NOW + h4, NOW, "en")).toBe("in 4h")
  })

  it("floors to minutes below an hour and abbreviates larger units (narrow style)", () => {
    expect(relativeCompact(NOW - 45 * 60 * 1000, NOW, "en")).toBe("45m ago")
    expect(relativeCompact(NOW + 2 * 24 * 60 * 60 * 1000, NOW, "en")).toBe("in 2d")
  })

  it("rounds sub-second deltas to 'now' via numeric:auto", () => {
    expect(relativeCompact(NOW - 500, NOW, "en")).toBe("now")
  })

  it("localizes through Intl.RelativeTimeFormat", () => {
    expect(relativeCompact(NOW - 4 * 60 * 60 * 1000, NOW, "zh-CN")).toBe("4小时前")
    expect(relativeCompact(NOW + 4 * 60 * 60 * 1000, NOW, "zh-CN")).toBe("4小时后")
  })
})
