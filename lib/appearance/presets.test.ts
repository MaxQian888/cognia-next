import {
  BUILTIN_COLOR_PRESETS,
  BUILTIN_GRADIENT_PRESETS,
  BUILTIN_WALLPAPERS,
  isBuiltinPresetId,
  withBuiltinPresets,
} from "./presets"

describe("BUILTIN_WALLPAPERS", () => {
  it("has at least 8 gradients and 4 colors and a deterministic order", () => {
    expect(BUILTIN_GRADIENT_PRESETS.length).toBeGreaterThanOrEqual(8)
    expect(BUILTIN_COLOR_PRESETS.length).toBeGreaterThanOrEqual(4)
    // Concatenated list starts with all gradients, then colors.
    expect(BUILTIN_WALLPAPERS.slice(0, BUILTIN_GRADIENT_PRESETS.length)).toEqual(
      BUILTIN_GRADIENT_PRESETS
    )
  })

  it("marks every preset as builtin and uses preset- ids", () => {
    for (const wp of BUILTIN_WALLPAPERS) {
      expect(wp.builtin).toBe(true)
      expect(wp.id.startsWith("preset-")).toBe(true)
    }
  })

  it("has unique ids", () => {
    const ids = BUILTIN_WALLPAPERS.map((w) => w.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("each preset's source.kind matches the top-level kind", () => {
    for (const wp of BUILTIN_WALLPAPERS) {
      expect(wp.kind).toBe(wp.source.kind)
    }
  })
})

describe("isBuiltinPresetId", () => {
  it("recognises the preset prefix", () => {
    expect(isBuiltinPresetId("preset-foo")).toBe(true)
  })
  it("rejects user-generated ids", () => {
    expect(isBuiltinPresetId("wallpaper-12345")).toBe(false)
    expect(isBuiltinPresetId("")).toBe(false)
  })
})

describe("withBuiltinPresets", () => {
  it("returns the built-ins when no user list is supplied", () => {
    expect(withBuiltinPresets(undefined)).toEqual(BUILTIN_WALLPAPERS)
    expect(withBuiltinPresets([])).toEqual(BUILTIN_WALLPAPERS)
  })

  it("appends user wallpapers after built-ins", () => {
    const user = {
      id: "wallpaper-mine",
      name: "Mine",
      kind: "color" as const,
      builtin: false,
      createdAt: 1,
      source: { kind: "color" as const, value: "#abcdef" },
    }
    const merged = withBuiltinPresets([user])
    expect(merged.length).toBe(BUILTIN_WALLPAPERS.length + 1)
    expect(merged[merged.length - 1]).toBe(user)
  })

  it("drops user rows that collide with a built-in id (built-in wins)", () => {
    const colliding = {
      ...BUILTIN_WALLPAPERS[0],
      name: "Hijacked",
    }
    const merged = withBuiltinPresets([colliding])
    expect(merged.length).toBe(BUILTIN_WALLPAPERS.length)
    expect(merged[0]).toEqual(BUILTIN_WALLPAPERS[0])
    expect(merged[0].name).not.toBe("Hijacked")
  })
})
