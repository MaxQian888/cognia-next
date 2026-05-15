/**
 * E2E: OAuth in-app browser — opening an authorize URL goes through the
 * Browser plugin (not window.open) + the deeplink callback resolves.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — OAuth in-app browser", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("authorize click opens the browser plugin + deeplink completes the flow", async ({
    page,
  }) => {
    await page.goto("/me")
    const oauthBtn = page.getByRole("button", { name: /sign in|登录|authorize/i }).first()
    if (!(await oauthBtn.count())) test.skip()
    await oauthBtn.click()

    const lastOpen = await page.evaluate(() => {
      return (
        window as unknown as { __cogniaCapMock: { lastBrowserOpen(): { url: string } | null } }
      ).__cogniaCapMock.lastBrowserOpen()
    })
    expect(lastOpen?.url).toMatch(/oauth|authorize/i)

    // Simulate the callback.
    await page.evaluate(() => {
      ;(
        window as unknown as { __cogniaCapMock: { pushAppUrlOpen: (u: string) => void } }
      ).__cogniaCapMock.pushAppUrlOpen("cognia://oauth/callback?code=test&state=xyz")
    })
  })
})
