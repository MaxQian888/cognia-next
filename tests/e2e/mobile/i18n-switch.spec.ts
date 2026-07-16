/**
 * E2E: i18n locale switching surfaces translated strings.
 *
 * The real mobile switcher is the QuickActionGrid language tile on /me
 * (data-testid="quick-language-toggle"), which cycles en → zh-CN. An earlier
 * version of this spec looked for a "Language" button + menuitem that never
 * existed and self-skipped when it wasn't found — i.e. it could never fail.
 * The tile must exist (hard assertion), and the switch must actually
 * re-render chrome in Chinese.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb, setCogniaSettings } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — i18n switching", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
    // Without a runtime mode the boot provider bounces /me to /welcome.
    await setCogniaSettings(page, { mobileRuntimeMode: "standalone" })
  })

  test("toggling the language tile to zh-CN renders Chinese chrome", async ({ page }) => {
    await page.goto("/me")
    const toggle = page.getByTestId("quick-language-toggle")
    // The switcher being gone IS the regression this spec exists for.
    await expect(toggle).toBeVisible({ timeout: 15_000 })

    // Default locale is en — the tile shows the current value ("EN").
    await expect(toggle).toContainText(/EN/i)
    // Activate via keyboard: /me runs entrance/stagger animations and live
    // status re-renders that keep shifting bounding boxes, which starves
    // mouse-click actionability ("element is not stable") — focus+Enter is
    // the same activation path without the box-stability wait.
    await toggle.focus()
    await page.keyboard.press("Enter")
    await expect(toggle).toContainText(/中文/)

    // The switch must propagate beyond the tile: /me chrome re-renders in
    // Chinese (the page <h1> is "我" in zh-CN).
    await expect(page.getByTestId("me-page").getByRole("heading", { level: 1 })).toContainText(
      /我/
    )

    // And it persists across navigation: the root tab bar shows 发现.
    await page.goto("/")
    const tabBar = page.getByTestId("mobile-tab-bar")
    await expect(tabBar.getByRole("tab", { name: /发现/ })).toBeVisible({ timeout: 15_000 })
  })
})
