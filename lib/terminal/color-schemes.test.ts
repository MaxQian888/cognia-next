import {
  AUTO_SCHEME_ID,
  TERMINAL_COLOR_SCHEMES,
  findColorScheme,
  resolveTerminalTheme,
} from "./color-schemes"

describe("color-schemes", () => {
  it("every scheme defines a complete 16-color ANSI palette", () => {
    const keys = [
      "background",
      "foreground",
      "cursor",
      "selectionBackground",
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ] as const
    for (const scheme of TERMINAL_COLOR_SCHEMES) {
      for (const k of keys) {
        expect(scheme.theme[k]).toMatch(/^#[0-9a-fA-F]{6,8}$/)
      }
    }
  })

  it("has unique scheme ids", () => {
    const ids = TERMINAL_COLOR_SCHEMES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("findColorScheme returns undefined for auto / unknown / empty", () => {
    expect(findColorScheme(AUTO_SCHEME_ID)).toBeUndefined()
    expect(findColorScheme(undefined)).toBeUndefined()
    expect(findColorScheme("no-such-scheme")).toBeUndefined()
  })

  it("findColorScheme resolves a known id", () => {
    const dracula = findColorScheme("dracula")
    expect(dracula?.name).toBe("Dracula")
    expect(dracula?.appearance).toBe("dark")
  })

  it("resolveTerminalTheme('auto') follows app dark/light", () => {
    const dark = resolveTerminalTheme(AUTO_SCHEME_ID, true)
    const light = resolveTerminalTheme(AUTO_SCHEME_ID, false)
    expect(dark.background).toBe("#0a0a0a")
    expect(light.background).toBe("#ffffff")
  })

  it("resolveTerminalTheme(named) ignores isDark and returns the fixed palette", () => {
    const a = resolveTerminalTheme("dracula", true)
    const b = resolveTerminalTheme("dracula", false)
    expect(a).toEqual(b)
    expect(a.background).toBe("#282a36")
  })

  it("resolveTerminalTheme(unknown) falls back to auto", () => {
    expect(resolveTerminalTheme("garbage", true).background).toBe("#0a0a0a")
  })
})
