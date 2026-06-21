import {
  BUILTIN_THEME_NAMES,
  BUILTIN_THEMES,
  DEFAULT_THEME_NAME,
  getBuiltinTheme,
} from "./builtins"

describe("builtin themes", () => {
  it("ansi reproduces the pre-theme ANSI look exactly", () => {
    const p = getBuiltinTheme("ansi")
    expect(p.accent).toBe("cyan")
    expect(p.success).toBe("green")
    expect(p.danger).toBe("red")
    expect(p.warning).toBe("yellow")
    expect(p.secondary).toBe("magenta")
    expect(p.info).toBe("blue")
    expect(p.muted).toBe("gray")
    expect(p.text).toBeUndefined() // terminal default fg, as before
    // derived element tokens stay on the historic colours
    expect(p.heading1).toBe("cyan")
    expect(p.diffAdded).toBe("green")
    expect(p.toolMcp).toBe("magenta")
  })

  it("resolves the legacy `classic` name to the raw-ANSI `ansi` palette", () => {
    expect(getBuiltinTheme("classic")).toEqual(BUILTIN_THEMES.ansi)
  })

  it("cognia is the signature warm dark default", () => {
    expect(DEFAULT_THEME_NAME).toBe("cognia")
    const p = getBuiltinTheme("cognia")
    expect(p.accent.toLowerCase()).toBe("#d77757") // Claude brand accent
    expect(p.text?.toLowerCase()).toBe("#e6e6e6") // explicit crisp body fg
    expect(p.border.toLowerCase()).toBe("#d77757") // accent cascades to borders
  })

  it("the default fallback is the cognia theme", () => {
    expect(getBuiltinTheme(undefined)).toEqual(BUILTIN_THEMES.cognia)
    expect(getBuiltinTheme("nonexistent-theme")).toEqual(BUILTIN_THEMES.cognia)
  })

  it("exposes a name list that matches the registry keys", () => {
    expect([...BUILTIN_THEME_NAMES].sort()).toEqual(Object.keys(BUILTIN_THEMES).sort())
  })

  it("hex themes carry truecolour values and an explicit text colour", () => {
    for (const name of ["dark", "light", "dark-daltonized", "light-daltonized"] as const) {
      const p = getBuiltinTheme(name)
      expect(p.accent).toMatch(/^#[0-9a-f]{6}$/i)
      expect(p.text).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it("mono avoids colour beyond white/gray", () => {
    const p = getBuiltinTheme("mono")
    const values = [p.accent, p.success, p.danger, p.warning, p.secondary, p.info]
    for (const v of values) expect(["white", "whiteBright", "gray"]).toContain(v)
  })

  it("every theme resolves to a complete palette", () => {
    for (const name of BUILTIN_THEME_NAMES) {
      const p = getBuiltinTheme(name)
      expect(p.border).toBeTruthy()
      expect(p.mascotWorking).toBeTruthy()
      expect(p.riskHigh).toBeTruthy()
    }
  })
})
