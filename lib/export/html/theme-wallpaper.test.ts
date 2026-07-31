import {
  WALLPAPER_THEME_IDS,
  themeHasWallpaper,
  resolveThemeWallpaper,
  buildWallpaperBackdropCss,
  buildCardWallpaperCss,
  rgbaFromHex,
} from "./theme-wallpaper"
import { THEMES } from "./syntax-themes"

// Mock the heavy generated map so the resolver tests stay fast and deterministic.
jest.mock("./wallpapers.generated", () => ({
  THEME_WALLPAPERS: {
    arknights: "data:image/webp;base64,QQQQ",
    cyberpunk: "data:image/webp;base64,WWWW",
  },
}))

const FAKE = "data:image/webp;base64,QQQQ"

describe("themeHasWallpaper", () => {
  it("is true for every immersive wallpaper theme", () => {
    for (const id of WALLPAPER_THEME_IDS) expect(themeHasWallpaper(id)).toBe(true)
  })

  it("is false for plain document themes and undefined", () => {
    expect(themeHasWallpaper("light")).toBe(false)
    expect(themeHasWallpaper("github")).toBe(false)
    expect(themeHasWallpaper(undefined)).toBe(false)
  })
})

describe("resolveThemeWallpaper", () => {
  it("returns undefined when disabled", async () => {
    expect(await resolveThemeWallpaper("arknights", false)).toBeUndefined()
  })

  it("returns undefined for a theme without a wallpaper even when enabled", async () => {
    expect(await resolveThemeWallpaper("light", true)).toBeUndefined()
    expect(await resolveThemeWallpaper(undefined, true)).toBeUndefined()
  })

  it("resolves the data URL for an enabled wallpaper theme", async () => {
    expect(await resolveThemeWallpaper("arknights", true)).toBe(FAKE)
  })

  it("returns undefined when the map has no entry for the theme", async () => {
    // `terminal` is a wallpaper theme id but absent from the mocked map.
    expect(await resolveThemeWallpaper("terminal", true)).toBeUndefined()
  })
})

describe("buildWallpaperBackdropCss", () => {
  it("layers the photo on html with a scrim and transparent body", () => {
    const css = buildWallpaperBackdropCss(FAKE, THEMES.arknights)
    expect(css).toContain(`url("${FAKE}")`)
    expect(css).toContain("linear-gradient(")
    expect(css).toContain("background-color: transparent")
    expect(css).toContain("rgba(")
    expect(css).toContain("background-attachment: scroll") // mobile fallback
  })
})

describe("buildCardWallpaperCss", () => {
  it("targets the card elements with the scrimmed photo", () => {
    const css = buildCardWallpaperCss(FAKE, THEMES.honkai)
    expect(css).toContain(".ucard, .qcard")
    expect(css).toContain(`url("${FAKE}")`)
    expect(css).toContain("rgba(")
  })
})

describe("rgbaFromHex", () => {
  it("expands 6-digit hex", () => {
    expect(rgbaFromHex("#23d5ff", 0.5)).toBe("rgba(35,213,255,0.5)")
  })

  it("expands 3-digit hex", () => {
    expect(rgbaFromHex("#0f0", 0.5)).toBe("rgba(0,255,0,0.5)")
  })

  it("falls back to grey for non-hex input", () => {
    expect(rgbaFromHex("not-a-color", 0.78)).toBe("rgba(128,128,128,0.78)")
  })
})
