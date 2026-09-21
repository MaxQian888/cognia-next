/**
 * E2E: the mobile `+` sheet's injected capability rows (Capacitor shell).
 *
 * The sheet's own entries are `PlusRow`s — full-width, 44px-tall
 * `menuitem`/`menuitemcheckbox` rows. The capability controls the composer
 * injects (web search, skills) must present identically: a phone has no hover
 * state to rescue a small or ambiguous target, so the row contract is checked
 * for real here, not just mocked in jsdom.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb, setCogniaSettings } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"

// `resolveWebAccess` gates the row's `preSearch` on the master switch AND a
// configured provider — seed both.
const TAVILY_PROVIDER = {
  searchEnabled: true,
  searchProviders: { tavily: { providerId: "tavily", enabled: true, apiKey: "e2e-key" } },
}

/**
 * ADR-0122: the onboarding gate routes a session-less account into the
 * first-run flow, so the `+` sheet is unreachable until a settled record says
 * the device has already been through it.
 */
const ONBOARDED = {
  mobileRuntimeMode: "standalone",
  onboardingProgress: {
    version: 2,
    path: "completed",
    completedAt: "2026-01-01T00:00:00.000Z",
  },
}

/**
 * Navigate in and open the sheet. Extra settings must be seeded BEFORE this —
 * after `resetCogniaDb` the post-reload settings write hits a locked account
 * cipher, so the only safe window is the same boot the reset ran on.
 */
async function openPlusSheet(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await page.getByTestId("composer-plus-toggle").click()
  await expect(page.getByTestId("composer-plus-menu")).toBeVisible()
}

test.describe("mobile composer plus — capability rows", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
    // `resetCogniaDb` clears `mobileRuntimeMode`, which parks the app on the
    // mode chooser — seed it like the other mobile specs do.
    await setCogniaSettings(page, ONBOARDED)
  })

  test("injected rows are touch-sized menu items and the web row toggles", async ({ page }) => {
    await setCogniaSettings(page, TAVILY_PROVIDER)
    await openPlusSheet(page)

    const sheet = page.getByTestId("composer-plus-menu")
    const webRow = sheet.getByRole("menuitemcheckbox", { name: "Toggle web search" })
    const skillRow = sheet.getByTestId("composer-skill-trigger")
    // The sheet's own checkable row is the yardstick for size.
    const planRow = sheet.getByRole("menuitemcheckbox", { name: "Plan mode" })
    await expect(webRow).toBeVisible()
    await expect(skillRow).toBeVisible()
    await expect(skillRow).toHaveRole("menuitem")

    const [webBox, planBox] = await Promise.all([webRow.boundingBox(), planRow.boundingBox()])
    // 44px touch floor, and the same full-width span as a PlusRow.
    expect(webBox?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(Math.abs((webBox?.width ?? 0) - (planBox?.width ?? 0))).toBeLessThanOrEqual(1)

    // Drill-down affordance, same as the sheet's submenu rows.
    await expect(skillRow.locator("svg.lucide-chevron-right")).toBeVisible()

    // menuitem semantics: the state is `aria-checked`, not `aria-pressed`,
    // and the sheet stays open so the dot is the feedback.
    await expect(webRow).toHaveAttribute("aria-checked", "false")
    await webRow.click()
    await expect(webRow).toHaveAttribute("aria-checked", "true")
    await expect(webRow.locator(".bg-primary")).toBeVisible()
  })

  test("a disabled web row carries aria-disabled and shows its reason in the row", async ({
    page,
  }) => {
    await openPlusSheet(page)

    const sheet = page.getByTestId("composer-plus-menu")
    const webRow = sheet.getByRole("menuitemcheckbox", { name: "Toggle web search" })
    await expect(webRow).toBeDisabled()
    // `disabled` is not announced on menuitem roles — PlusRow sets
    // aria-disabled explicitly, and the hint line carries the reason because
    // there is no hover tooltip on touch.
    await expect(webRow).toHaveAttribute("aria-disabled", "true")
    await expect(webRow).toContainText("Enable in Settings")
  })
})
