/**
 * E2E: connection strategy falls back to the configured tunnel URL when
 * LAN discovery yields no candidates.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — tunnel fallback", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android", mdnsResults: [] })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("empty mDNS results surface the manual / tunnel entry path", async ({ page }) => {
    await page.goto("/pair")
    await expect(page.getByText(/manual|tunnel|手动|隧道/i).first()).toBeVisible({
      timeout: 15_000,
    })
  })
})
