/**
 * Contract: across the app's main routes, a busy wallpaper under every theme
 * case leaves theme text legible and paints no panel as a solid block over
 * the image — measured from real rendered pixels.
 *
 * `wallpaper-legibility.spec.ts` pins the guard itself on the wallpaper panel;
 * this sweep is the coverage half: a route whose surfaces bypass the tiers (a
 * literal `bg-sidebar` rail, a hairline grid of `bg-card` cells, a primary
 * bloom behind a hero) fails here by name. The black-and-white stripe
 * wallpaper is the worst case for both directions of contrast at once.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import {
  THEMES,
  WALLPAPERS,
  collectThemeText,
  completeOnboarding,
  describeSample,
  findOpaqueIslands,
  legibilityFailures,
  measureTextBackdrops,
  mountApp,
  showWallpaper,
  waitForCap,
} from "../helpers/wallpaper-legibility"

const ROUTES = [
  "/",
  "/inbox",
  "/workflows",
  "/memory",
  "/files",
  "/conversations",
  "/projects",
  "/skills",
  "/plugins",
  "/scheduler",
  "/goals",
  "/issues",
  "/templates",
  "/agent-teams",
  "/devices",
  "/source-control",
  "/settings?section=appearance&appearanceTab=theme",
  "/settings?section=agent-runtime",
  "/settings?section=account",
]

test.describe("wallpaper — legibility and surfaces across routes", () => {
  for (const route of ROUTES) {
    for (const theme of THEMES) {
      test(`${route} × ${theme.name}`, async ({ page }) => {
        // One page load per test: see wallpaper-legibility.spec.ts.
        await page.goto(route, { waitUntil: "domcontentloaded" })
        await mountApp(page)
        await completeOnboarding(page)
        await page.emulateMedia({ colorScheme: theme.colorScheme })
        await showWallpaper(page, WALLPAPERS.busy, theme)
        await waitForCap(page)
        // Route content mounts lazily after onboarding completes.
        await page.waitForTimeout(1500)

        const islands = await findOpaqueIslands(page)
        expect(
          islands.map((i) => `${i.token} ${i.width}×${i.height} ${i.label}`),
          `solid panels over the wallpaper on ${route} × ${theme.name}`
        ).toEqual([])

        const samples = await collectThemeText(page)
        const failures = legibilityFailures(await measureTextBackdrops(page, samples))
        expect(
          failures.map(describeSample),
          `text below target on ${route} × ${theme.name}`
        ).toEqual([])
      })
    }
  }
})

/**
 * Overlays are portaled to <body>, outside every wallpaper target, and only sit
 * over the image under the document-wide scopes. They paint the overlay tier
 * (the most opaque one) with a regular blur; this pins that text inside them
 * stays legible over the busy wallpaper too.
 */
const OVERLAYS: ReadonlyArray<{
  name: string
  route: string
  open: (page: import("@playwright/test").Page) => Promise<void>
  within: string
}> = [
  {
    name: "command palette",
    route: "/",
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+k")
      await page.getByTestId("global-search-dialog").waitFor()
    },
    within: '[data-testid="global-search-dialog"]',
  },
  {
    name: "dropdown menu",
    route: "/scheduler",
    open: async (page) => {
      await page.locator('[data-slot="dropdown-menu-trigger"]').first().click()
      await page.locator('[data-slot="dropdown-menu-content"]').waitFor()
    },
    within: '[data-slot="dropdown-menu-content"]',
  },
]

test.describe("wallpaper — legibility inside overlays", () => {
  for (const overlay of OVERLAYS) {
    for (const theme of THEMES) {
      test(`${overlay.name} × ${theme.name}`, async ({ page }) => {
        await page.goto(overlay.route, { waitUntil: "domcontentloaded" })
        await mountApp(page)
        await completeOnboarding(page)
        await page.emulateMedia({ colorScheme: theme.colorScheme })
        await showWallpaper(page, WALLPAPERS.busy, theme)
        await waitForCap(page)
        await page.waitForTimeout(1500)
        await overlay.open(page)
        // Let the open animation finish before the pixels are read.
        await page.waitForTimeout(500)

        const samples = await collectThemeText(page, overlay.within)
        expect(samples.length, `${overlay.name} should show theme text`).toBeGreaterThan(0)
        const failures = legibilityFailures(await measureTextBackdrops(page, samples))
        expect(
          failures.map(describeSample),
          `text below target in the ${overlay.name} × ${theme.name}`
        ).toEqual([])
      })
    }
  }
})
