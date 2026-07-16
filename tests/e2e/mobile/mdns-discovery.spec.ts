/**
 * E2E: mDNS auto-discovery surfaces candidate servers on pair step 1.
 *
 * The assertion binds to the INJECTED host (10.0.0.5) — an earlier version
 * fell back to `.or(getByText(/discovered|发现/i))`, which passes on generic
 * copy without ever proving the injected mDNS result surfaced.
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

  test("step 1 shows the discovered server's host", async ({ page }) => {
    await page.goto("/pair")
    await expect(page.getByText(/10\.0\.0\.5/).first()).toBeVisible({ timeout: 15_000 })
  })
})
