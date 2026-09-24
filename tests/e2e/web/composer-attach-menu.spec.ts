/**
 * E2E: the composer `+` menu's injected capability rows (desktop web).
 *
 * The capability controls (web search, skills, room target) used to mount as
 * a loose chip strip inside the attach popover — visibly not menu rows. These
 * checks pin the row contract in a real browser: the same width and type as
 * the menu's own PanelItem rows, `aria-pressed` toggle semantics, a reachable
 * tooltip on the disabled row, and the same layout in a compact viewport.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

// `resolveWebAccess` gates the row's `preSearch` on the master switch AND a
// configured provider — seed both.
const TAVILY_PROVIDER = {
  searchEnabled: true,
  searchProviders: { tavily: { providerId: "tavily", enabled: true, apiKey: "e2e-key" } },
}

/**
 * ADR-0122: the onboarding gate routes a session-less account into the
 * first-run flow — the seeded E2E account starts with zero sessions, so the
 * composer never mounts without a settled record.
 */
const ONBOARDED = {
  onboardingProgress: {
    version: 2,
    path: "completed",
    completedAt: "2026-01-01T00:00:00.000Z",
  },
}

test.describe("web — composer attach menu capability rows", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await waitForTestGlobals(page, 30_000)
    await setCogniaSettings(page, ONBOARDED)
    // The gate's verdict latches per boot; a reload re-reads the settled row.
    await page.goto("about:blank")
    await page.goto("/", { waitUntil: "domcontentloaded" })
  })

  test("capability entries render as full-width menu rows and the web row toggles", async ({
    page,
  }) => {
    await setCogniaSettings(page, TAVILY_PROVIDER)
    await page.getByTestId("composer-attach-menu").click()

    const webRow = page.getByRole("button", { name: "Toggle web search" })
    const skillRow = page.getByTestId("composer-skill-trigger")
    // A menu's own entry is the yardstick: the injected rows must match its
    // width and body size, not read as a chip strip.
    const planRow = page.getByRole("button", { name: "Plan mode" })
    await expect(webRow).toBeVisible()
    await expect(skillRow).toBeVisible()
    await expect(planRow).toBeVisible()

    const [webBox, planBox] = await Promise.all([webRow.boundingBox(), planRow.boundingBox()])
    expect(Math.abs((webBox?.width ?? 0) - (planBox?.width ?? 0))).toBeLessThanOrEqual(1)
    const [webFont, planFont] = await Promise.all([
      webRow.evaluate((el) => getComputedStyle(el).fontSize),
      planRow.evaluate((el) => getComputedStyle(el).fontSize),
    ])
    expect(webFont).toBe(planFont)

    // Drill-down affordance, same as the menu's submenu rows.
    await expect(skillRow.locator("svg.lucide-chevron-right")).toBeVisible()

    // The toggle is a real toggle button — and the popover stays open so the
    // newly-lit state dot is the feedback (there is no chip elsewhere).
    await expect(webRow).toHaveAttribute("aria-pressed", "false")
    await webRow.click()
    await expect(webRow).toHaveAttribute("aria-pressed", "true")
    await expect(webRow.locator(".bg-primary")).toBeVisible()
  })

  test("an unconfigured web row explains how to enable it", async ({ page }) => {
    // Out of the box the master search switch is off and no provider is set,
    // so web search cannot run. The row is not a dead disabled toggle: it
    // names the blocker on hover and opens a setup card pointing at the
    // settings section that fixes it.
    const reason = "Web search is off — turn it on in Settings → Web search"
    await page.getByTestId("composer-attach-menu").click()
    const webRow = page.getByRole("button", { name: "Toggle web search" })
    await expect(webRow).toBeEnabled()
    await expect(webRow).toHaveAttribute("aria-haspopup", "dialog")
    // Not a toggle in this state — no pressed semantics, no armed dot.
    await expect(webRow).not.toHaveAttribute("aria-pressed")

    await webRow.hover()
    await expect(page.getByRole("tooltip").filter({ hasText: reason })).toBeVisible()

    await webRow.click()
    await expect(webRow).toHaveAttribute("aria-expanded", "true")
    const setupCard = page.getByRole("dialog").filter({ hasText: reason })
    await expect(setupCard).toBeVisible()
    await expect(setupCard.getByRole("button", { name: "Open settings" })).toBeVisible()
  })

  test("the rows stay full-width in a compact-width viewport", async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 840 })
    await page.getByTestId("composer-attach-menu").click()

    const webRow = page.getByRole("button", { name: "Toggle web search" })
    const planRow = page.getByRole("button", { name: "Plan mode" })
    await expect(webRow).toBeVisible()

    const [webBox, planBox] = await Promise.all([webRow.boundingBox(), planRow.boundingBox()])
    expect(Math.abs((webBox?.width ?? 0) - (planBox?.width ?? 0))).toBeLessThanOrEqual(1)
  })
})
