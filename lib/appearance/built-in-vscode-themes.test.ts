import { BUILT_IN_VSCODE_THEMES } from "./built-in-vscode-themes"

describe("BUILT_IN_VSCODE_THEMES", () => {
  it("contains five presets", () => {
    expect(BUILT_IN_VSCODE_THEMES.length).toBe(5)
  })

  it.each(BUILT_IN_VSCODE_THEMES.map((t) => [t.name, t] as const))(
    "%s has dual-variant tokens with both light and dark populated",
    (_name, theme) => {
      expect(theme.tokens?.light).toBeDefined()
      expect(theme.tokens?.dark).toBeDefined()
      expect(theme.tokens?.light.background).toMatch(/^(#|oklch\()/)
      expect(theme.tokens?.dark.background).toMatch(/^(#|oklch\()/)
    }
  )

  it("never uses the hardcoded blue fallback for accent or ring", () => {
    for (const theme of BUILT_IN_VSCODE_THEMES) {
      const dark = theme.tokens?.dark
      const light = theme.tokens?.light
      expect(dark?.accent).not.toBe("#60a5fa")
      expect(dark?.ring).not.toBe("#60a5fa")
      expect(light?.accent).not.toBe("#3b82f6")
      expect(light?.ring).not.toBe("#3b82f6")
    }
  })

  it("Dracula is dark, GitHub Light Default is light", () => {
    const dracula = BUILT_IN_VSCODE_THEMES.find((t) => t.name === "Dracula")
    const githubLight = BUILT_IN_VSCODE_THEMES.find((t) => t.name === "GitHub Light Default")
    expect(dracula?.baseVariant).toBe("dark")
    expect(githubLight?.baseVariant).toBe("light")
  })

  it("keeps Night Owl aligned with the canonical VS Code workbench palette", () => {
    const nightOwl = BUILT_IN_VSCODE_THEMES.find((t) => t.name === "Night Owl")

    expect(nightOwl?.baseVariant).toBe("dark")
    expect(nightOwl?.colors).toMatchObject({
      background: "#011627",
      foreground: "#d6deeb",
      primary: "#7e57c2",
      primaryForeground: "#ffffff",
      accent: "#234d70",
      accentForeground: "#ffffff",
      sidebar: "#011627",
      sidebarForeground: "#89a4bb",
    })
  })

  it("populates legacy colors + isDark fields for rollback compatibility", () => {
    for (const theme of BUILT_IN_VSCODE_THEMES) {
      expect(theme.colors).toBeDefined()
      expect(typeof theme.isDark).toBe("boolean")
    }
  })

  it("derivedVariant is the opposite of baseVariant", () => {
    for (const theme of BUILT_IN_VSCODE_THEMES) {
      expect(theme.derivedVariant).toBe(theme.baseVariant === "dark" ? "light" : "dark")
    }
  })
})
