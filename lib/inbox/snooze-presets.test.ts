import { SNOOZE_PRESETS, snoozeUntilFor } from "./snooze-presets"

describe("snooze presets", () => {
  it("offers 1h, 8h and 24h in that order", () => {
    expect(SNOOZE_PRESETS.map((preset) => preset.key)).toEqual(["1h", "8h", "24h"])
    expect(SNOOZE_PRESETS.map((preset) => preset.ms)).toEqual([3_600_000, 28_800_000, 86_400_000])
  })

  it("adds the preset's duration to the start time", () => {
    expect(snoozeUntilFor("1h", 500)).toBe(500 + 3_600_000)
    expect(snoozeUntilFor("24h", 0)).toBe(86_400_000)
  })

  it("rejects an unknown preset", () => {
    expect(() => snoozeUntilFor("3d" as never, 0)).toThrow("Unknown snooze preset: 3d")
  })
})
