import {
  IM_MODE_CUSTOM,
  IM_MODE_PRESETS,
  IM_MODE_PRESET_IDS,
  imModePresetFor,
  imModePresetPatch,
  imModePresetUnavailableReason,
  type ImModePresetId,
} from "./im-mode-presets"
import { connectorModeFromComposition } from "./mode-projection"

describe("imModePresetFor", () => {
  it.each([
    [{ autonomy: "act", engagement: "inline" }, "assistant"],
    [{ autonomy: "act", engagement: "background" }, "delegate"],
    [{ autonomy: "suggest", engagement: "inline" }, "draft"],
    [{ autonomy: "suggest", engagement: "background" }, "draft"],
    [{ autonomy: "observe", engagement: "inline" }, "silent"],
    [{ autonomy: "act", engagement: "human" }, "silent"],
  ] as const)("names %o as %s", (axes, expected) => {
    expect(imModePresetFor(axes)).toBe(expected)
  })

  // `confirm` and `autopilot` are reachable through the advanced editor and
  // through `/mode`, and neither is one of the four named combinations.
  it.each(["confirm", "autopilot"] as const)("reports %s as custom", (autonomy) => {
    expect(imModePresetFor({ autonomy, engagement: "inline" })).toBe(IM_MODE_CUSTOM)
  })

  it("treats not-running as silent whatever else is set", () => {
    expect(imModePresetFor({ autonomy: "autopilot", engagement: "human" })).toBe("silent")
    expect(imModePresetFor({ autonomy: "observe", engagement: "background" })).toBe("silent")
  })
})

describe("imModePresetPatch", () => {
  it.each(IM_MODE_PRESET_IDS)("round-trips %s back to itself", (preset) => {
    const patch = imModePresetPatch(preset)
    expect(
      imModePresetFor({
        autonomy: patch.autonomy,
        // An unwritten engagement is derived; inline is what it derives to for
        // the direct target this round-trip assumes.
        engagement: patch.engagement ?? "inline",
      })
    ).toBe(preset)
  })

  // Switching away from `delegate` has to REMOVE the frozen background value,
  // not merely omit it — otherwise the conversation keeps running in the
  // background under a preset that says it answers inline.
  it("clears engagement for the presets that leave it derived", () => {
    expect(imModePresetPatch("assistant")).toHaveProperty("engagement", undefined)
    expect(imModePresetPatch("draft")).toHaveProperty("engagement", undefined)
    expect(imModePresetPatch("delegate").engagement).toBe("background")
    expect(imModePresetPatch("silent").engagement).toBe("human")
  })

  it("mirrors the legacy mode every preset means", () => {
    expect(imModePresetPatch("assistant").mode).toBe("auto")
    expect(imModePresetPatch("delegate").mode).toBe("auto")
    expect(imModePresetPatch("draft").mode).toBe("draft")
    expect(imModePresetPatch("silent").mode).toBe("manual")
  })

  it("keeps the mirror consistent with the projection it comes from", () => {
    for (const preset of IM_MODE_PRESET_IDS) {
      const axes = IM_MODE_PRESETS[preset]
      expect(imModePresetPatch(preset).mode).toBe(
        connectorModeFromComposition(axes.autonomy, axes.engagement ?? "inline")
      )
    }
  })
})

describe("imModePresetUnavailableReason", () => {
  it("refuses delegate without an execution target to carry it", () => {
    expect(imModePresetUnavailableReason("delegate", "direct")).toBe("delegate_needs_target")
  })

  it.each(["team", "workflow"] as const)("allows delegate onto a %s", (targetKind) => {
    expect(imModePresetUnavailableReason("delegate", targetKind)).toBeNull()
  })

  it.each(["assistant", "draft", "silent"] as const)(
    "never blocks %s — none of them needs a target",
    (preset: ImModePresetId) => {
      expect(imModePresetUnavailableReason(preset, "direct")).toBeNull()
    }
  )
})
