import { normalizeDockPresetName, uniqueDockPresetName } from "./naming"
import { DOCK_PRESET_NAME_MAX_LENGTH } from "@/types/dock/preset"

const format = (name: string, count: number) => `${name} (${count})`

describe("normalizeDockPresetName", () => {
  it("trims, collapses whitespace and clamps the length", () => {
    expect(normalizeDockPresetName("  Review   layout \n")).toBe("Review layout")
    expect(normalizeDockPresetName("x".repeat(200))).toHaveLength(DOCK_PRESET_NAME_MAX_LENGTH)
  })
})

describe("uniqueDockPresetName", () => {
  it("keeps a free name as-is", () => {
    expect(uniqueDockPresetName({ name: "Review", taken: ["Other"], format })).toBe("Review")
  })

  it("suffixes rather than overwriting a name already in use", () => {
    // The stored preset is the user's arrangement; a file from elsewhere has no
    // claim on its name.
    expect(uniqueDockPresetName({ name: "Review", taken: ["Review"], format })).toBe("Review (2)")
  })

  it("keeps counting past an existing suffix", () => {
    expect(uniqueDockPresetName({ name: "Review", taken: ["Review", "Review (2)"], format })).toBe(
      "Review (3)"
    )
  })

  it("treats names case-insensitively", () => {
    // "Review" and "review" reading as two presets in one list is a bug.
    expect(uniqueDockPresetName({ name: "Review", taken: ["review"], format })).toBe("Review (2)")
  })

  it("normalises before comparing", () => {
    expect(uniqueDockPresetName({ name: "  Review  ", taken: [" review "], format })).toBe(
      "Review (2)"
    )
  })

  it("uses the caller's localised suffix template", () => {
    expect(
      uniqueDockPresetName({
        name: "布局",
        taken: ["布局"],
        format: (name, count) => `${name} 副本 ${count}`,
      })
    ).toBe("布局 副本 2")
  })

  it("gives up on the base name rather than looping forever", () => {
    const taken = ["Review", ...Array.from({ length: 1200 }, (_, i) => `Review (${i + 2})`)]
    expect(uniqueDockPresetName({ name: "Review", taken, format })).toBe("Review")
  })
})
