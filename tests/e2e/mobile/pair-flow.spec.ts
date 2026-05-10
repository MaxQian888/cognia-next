/**
 * Wave 3.7 — Mobile pair flow smoke spec.
 *
 * Drives the `/pair` page on a phone-shaped viewport and walks through the
 * three-step wizard: Discover → Pair (manual paste fallback) → error path
 * for invalid baseUrl. Does not actually pair against a live desktop server;
 * the assertions check the page shape, the stepper state machine, and the
 * accessibility tree.
 *
 * Run:
 *   pnpx playwright test --project=mobile-pixel-7 tests/e2e/mobile/pair-flow.spec.ts
 *
 * Fixture: a real desktop server is *not* required for this spec; the page
 * renders the discover step when no companion config exists in storage.
 */

import { expect, test } from "@playwright/test"

test.describe("mobile pair flow", () => {
  test("lands on the discover step with a stepper visible", async ({ page }) => {
    await page.goto("/pair")
    await expect(page.getByTestId("pair-onboarding")).toBeVisible()
    await expect(page.getByTestId("pair-stepper")).toBeVisible()
    await expect(page.getByTestId("pair-discover-step")).toBeVisible()
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "discover")
  })

  test("Skip to manual reveals the pair form", async ({ page }) => {
    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await expect(page.getByTestId("pair-pair-step")).toBeVisible()
    await expect(page.getByTestId("pair-scan-qr")).toBeVisible()
    await expect(page.getByTestId("pair-baseurl")).toBeVisible()
    await expect(page.getByTestId("pair-jwt")).toBeVisible()
    await expect(page.getByTestId("pair-submit")).toBeVisible()
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")
  })

  test("rejects an invalid baseUrl with a recoverable error", async ({ page }) => {
    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-baseurl").fill("not a url")
    await page.getByTestId("pair-jwt").fill("aaa.bbb.ccc")
    await page.getByTestId("pair-submit").click()
    await expect(page.getByTestId("pair-error")).toBeVisible()
  })

  test("Back button returns to the discover step", async ({ page }) => {
    await page.goto("/pair")
    await page.getByTestId("pair-discover-skip").click()
    await page.getByTestId("pair-back-to-discover").click()
    await expect(page.getByTestId("pair-discover-step")).toBeVisible()
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "discover")
  })
})
