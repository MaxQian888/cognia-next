/**
 * Contract: with the wallpaper legibility guard on, theme-coloured text stays
 * legible over any wallpaper under any theme — measured from real rendered
 * pixels, not from the solver's own arithmetic.
 *
 * Matrix: a night, a paper and a black-and-white wallpaper × the light, dark,
 * high-contrast-dark and a colour-preset theme. For each, text is hidden, the
 * page is screenshotted, and the backdrop pixels behind every foreground /
 * muted-foreground text element are measured against that text's colour. The
 * wallpapers are hard-edged gradients so the worst patch is known exactly.
 *
 * Also pins the light/dark fit: a wallpaper that fights the theme gets the
 * "suits dark / light" hint, and "follow the wallpaper" switches the theme.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { DEFAULT_AUTOMODE } from "@/types/appearance"
import {
  THEMES,
  WALLPAPERS,
  collectThemeText,
  completeOnboarding,
  describeSample,
  legibilityFailures,
  measureTextBackdrops,
  mountApp,
  saveSettings,
  showWallpaper,
  waitForCap,
} from "../helpers/wallpaper-legibility"

const WALLPAPER_PANEL = "/settings?section=appearance&appearanceTab=wallpaper"

test.describe("settings — wallpaper legibility guard", () => {
  // One page load per test. A second full navigation re-runs the account gate
  // on a development server, and the disposable account it provisions for a
  // fresh profile is not guaranteed to come back — so everything after this
  // is applied live through the settings store, which the wallpaper applier,
  // the guard and the theme all react to without a reload.
  test.beforeEach(async ({ page }) => {
    await page.goto(WALLPAPER_PANEL, { waitUntil: "domcontentloaded" })
    await mountApp(page)
    await completeOnboarding(page)
  })

  for (const theme of THEMES) {
    for (const [name, wallpaper] of Object.entries(WALLPAPERS)) {
      test(`keeps theme text legible: ${name} wallpaper × ${theme.name}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme.colorScheme })
        await showWallpaper(page, wallpaper, theme)
        const cap = await waitForCap(page)
        expect(cap).toBeGreaterThan(0)
        expect(cap).toBeLessThanOrEqual(1)

        // The image is painted at the cap, not the slider's 100%: every layer
        // is an opaque composite — theme ground, the image, then a veil of
        // ground at (1 − painted weight) — so nested layers do not compound.
        const layers = await page.evaluate(() => {
          const probe = document.createElement("span")
          probe.style.opacity = "var(--app-bg-painted-opacity)"
          document.body.appendChild(probe)
          const weight = Number(getComputedStyle(probe).opacity)
          probe.remove()
          const painted = [...document.querySelectorAll("[data-bg-target]")]
            .map((el) => getComputedStyle(el, "::before"))
            .filter((cs) => cs.backgroundImage !== "none")
            .map((cs) => ({ opacity: Number(cs.opacity), image: cs.backgroundImage }))
          return { weight, painted }
        })
        expect(layers.weight).toBeCloseTo(cap, 2)
        expect(layers.painted.length).toBeGreaterThan(0)
        for (const layer of layers.painted) {
          expect(layer.opacity).toBe(1)
          expect(layer.image.startsWith("linear-gradient(")).toBe(true)
        }

        const samples = await collectThemeText(page)
        expect(samples.length, "the wallpaper panel should show theme text").toBeGreaterThan(10)
        const failures = legibilityFailures(await measureTextBackdrops(page, samples))
        expect(
          failures.map(describeSample),
          `text below target over ${name} × ${theme.name}`
        ).toEqual([])
      })
    }
  }

  test("suggests the variant a wallpaper suits, and following it switches the theme", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" })
    await showWallpaper(page, WALLPAPERS.night, THEMES[0]!)
    await saveSettings(page, { autoMode: { ...DEFAULT_AUTOMODE, enabled: false } })
    await waitForCap(page)

    const hint = page.getByTestId("wallpaper-theme-fit")
    await expect(hint).toContainText("suits a dark theme")
    await hint.getByRole("button", { name: "Follow the wallpaper automatically" }).click()

    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")), {
        timeout: 15_000,
      })
      .toBe(true)
    // Now matching, the hint goes away.
    await expect(hint).toBeHidden()
  })

  test("says nothing when the theme already suits the wallpaper", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" })
    await showWallpaper(page, WALLPAPERS.night, THEMES[1]!)
    await waitForCap(page)
    await expect(page.getByTestId("wallpaper-contrast-chip")).toBeVisible()
    await expect(page.getByTestId("wallpaper-theme-fit")).toBeHidden()
  })
})
