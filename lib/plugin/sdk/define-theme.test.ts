import { defineTheme } from "./define-theme"

describe("defineTheme", () => {
  it("returns an inline-colors theme unchanged (pure pass-through)", () => {
    const t = defineTheme({
      id: "noir",
      name: "Noir",
      isDark: true,
      colors: { background: "oklch(0.18 0 0)", foreground: "oklch(0.95 0 0)" },
    })
    expect(t).toEqual({
      id: "noir",
      name: "Noir",
      isDark: true,
      colors: { background: "oklch(0.18 0 0)", foreground: "oklch(0.95 0 0)" },
    })
  })

  it("preserves the vscodeJsonPath variant", () => {
    const t = defineTheme({ id: "imported", name: "Imported", vscodeJsonPath: "themes/dark.json" })
    expect(t).toMatchObject({ vscodeJsonPath: "themes/dark.json" })
  })

  it("preserves the cssVariables variant", () => {
    const t = defineTheme({ id: "tweak", name: "Tweak", cssVariables: { "--radius": "0.75rem" } })
    expect(t).toMatchObject({ cssVariables: { "--radius": "0.75rem" } })
  })
})
