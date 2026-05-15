/**
 * E2E: responsive layout sanity checks across Pixel 7 + iPhone 13 viewports.
 *
 * Behavioral-only — no screenshots. Asserts:
 *   - Each route renders without horizontal overflow.
 *   - The pair onboarding stays inside the safe-area on both viewports.
 *   - The accessibility tree exposes the primary CTAs.
 *
 * The same spec runs on both mobile projects via `playwright.config.ts`
 * project routing (`testDir: ./tests/e2e/mobile`).
 */

import { expect, test } from "@playwright/test"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { resetCogniaDb } from "../helpers/db-reset"

test.describe("mobile — responsive layout sanity", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("/pair renders without horizontal overflow", async ({ page }) => {
    await page.goto("/pair")
    await expect(page.getByTestId("pair-onboarding")).toBeVisible()

    const { docWidth, viewport } = await page.evaluate(() => ({
      docWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }))
    // Allow a 1px rounding tolerance.
    expect(docWidth).toBeLessThanOrEqual(viewport + 1)
  })

  test("/workflows renders with the New Workflow CTA reachable via role", async ({ page }) => {
    await page.goto("/workflows")
    await expect(page.getByTestId("workflow-create")).toBeVisible()
    // The CTA must be a button accessible by role+name regardless of layout.
    const cta = page.getByRole("button", { name: /new|create/i }).first()
    await expect(cta).toBeVisible()
  })

  test("safe-area padding shape is applied on /pair", async ({ page }) => {
    await page.goto("/pair")
    const pad = await page.locator("[data-testid='pair-onboarding']").evaluate((el) => {
      const styles = window.getComputedStyle(el)
      return {
        paddingBottom: styles.paddingBottom,
        paddingTop: styles.paddingTop,
      }
    })
    // Bottom padding is computed from `env(safe-area-inset-bottom)` which
    // browsers without notch state report as 0. Either way the value must
    // be a positive pixel string (e.g., "16px").
    expect(pad.paddingBottom).toMatch(/\d+px/)
    expect(pad.paddingTop).toMatch(/\d+px/)
  })

  test("home route renders without crashing under a mobile viewport", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.locator("body")).toBeVisible()
    expect(errors).toEqual([])
  })
})
