/**
 * E2E: mDNS auto-discovery surfaces candidate servers on step 1.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — mDNS discovery", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, {
      platform: "android",
      mdnsResults: [{ host: "10.0.0.5", port: 7891, fingerprint: "abcd" }],
    })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("step 1 shows the discovered server card", async ({ page }) => {
    await page.goto("/pair")
    await expect(
      page
        .getByText(/10\.0\.0\.5/)
        .or(page.getByText(/discovered|发现/i))
        .first()
    ).toBeVisible({
      timeout: 15_000,
    })
  })
})
