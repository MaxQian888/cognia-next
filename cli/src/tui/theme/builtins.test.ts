import { BUILTIN_THEME_NAMES, BUILTIN_THEMES, getBuiltinTheme } from "./builtins"

describe("builtin themes", () => {
  it("classic reproduces the pre-theme ANSI look exactly", () => {
    const p = getBuiltinTheme("classic")
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

  it("classic is the default fallback", () => {
    expect(getBuiltinTheme(undefined)).toEqual(BUILTIN_THEMES.classic)
    expect(getBuiltinTheme("nonexistent-theme")).toEqual(BUILTIN_THEMES.classic)
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
