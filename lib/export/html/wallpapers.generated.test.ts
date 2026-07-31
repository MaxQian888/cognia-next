import { THEME_WALLPAPERS } from "./wallpapers.generated"
import { WALLPAPER_THEME_IDS } from "./theme-wallpaper"

// Guards the committed, generated wallpaper map so a bad regeneration (empty,
// oversized, or drifted keys) fails CI instead of shipping.
describe("THEME_WALLPAPERS (generated)", () => {
  const entries = Object.entries(THEME_WALLPAPERS)

  it("has at least one wallpaper", () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  it("every key is a known wallpaper theme id", () => {
    const allowed = new Set<string>(WALLPAPER_THEME_IDS)
    for (const [id] of entries) expect(allowed.has(id)).toBe(true)
  })

  it("every value is an image data URL under the size ceiling", () => {
    for (const [, url] of entries) {
      expect(url).toMatch(/^data:image\/(webp|jpeg|png);base64,/)
      // ~160 KB base64 ceiling (≈120 KB raw); catches an accidental huge inline.
      expect(url.length).toBeLessThan(180 * 1024)
    }
  })
})
