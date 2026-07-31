import {
  MODEL_PRESET_VALUES,
  PERMISSION_MODE_VALUES,
  type ModelPresetValue,
  type PermissionModeValue,
} from "./model-presets"

describe("MODEL_PRESET_VALUES", () => {
  it("exposes the canonical Claude model ids", () => {
    expect(MODEL_PRESET_VALUES).toEqual([
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ])
  })

  it("contains no duplicates", () => {
    const set = new Set<string>(MODEL_PRESET_VALUES)
    expect(set.size).toBe(MODEL_PRESET_VALUES.length)
  })

  it("ModelPresetValue assignments compile for each entry", () => {
    for (const v of MODEL_PRESET_VALUES) {
      const assigned: ModelPresetValue = v
      expect(typeof assigned).toBe("string")
    }
  })
})

describe("PERMISSION_MODE_VALUES", () => {
  it("covers every Claude Agent SDK permission mode", () => {
    expect(PERMISSION_MODE_VALUES).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
      "dontAsk",
      "auto",
    ])
  })

  it("PermissionModeValue is type-compatible with each entry", () => {
    for (const v of PERMISSION_MODE_VALUES) {
      const assigned: PermissionModeValue = v
      expect(typeof assigned).toBe("string")
    }
  })
})
