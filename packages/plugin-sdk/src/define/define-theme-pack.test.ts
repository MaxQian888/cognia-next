import { defineThemePack } from "./define-theme-pack"

describe("defineThemePack", () => {
  it("returns the pack unchanged (pure pass-through)", () => {
    const p = defineThemePack({
      id: "aurora-comfort",
      name: "Aurora Comfort",
      applies: { themeId: "aurora", fontFamily: "Inter", density: "comfortable" },
    })
    expect(p).toEqual({
      id: "aurora-comfort",
      name: "Aurora Comfort",
      applies: { themeId: "aurora", fontFamily: "Inter", density: "comfortable" },
    })
  })

  it("preserves a partial applies bundle (fonts + wallpaper only)", () => {
    const p = defineThemePack({
      id: "fonts-only",
      name: "Fonts Only",
      applies: { fontFamily: "JetBrains Mono", wallpaperId: "wp-1" },
    })
    expect(p.applies).toMatchObject({ fontFamily: "JetBrains Mono", wallpaperId: "wp-1" })
  })
})
