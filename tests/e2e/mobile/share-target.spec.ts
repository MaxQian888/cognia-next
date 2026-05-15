/**
 * E2E: mobile share-target intent receiver — incoming cognia://share opens
 * the share intake screen with the payload preview.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — share target", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("cognia://share deeplink renders the intake screen with text preview", async ({ page }) => {
    await page.evaluate(() => {
      const mock = (
        window as unknown as { __cogniaCapMock: { pushAppUrlOpen: (url: string) => void } }
      ).__cogniaCapMock
      mock.pushAppUrlOpen("cognia://share?text=" + encodeURIComponent("hello share"))
    })
    await expect(page.getByText(/share|分享/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("hello share")).toBeVisible({ timeout: 15_000 })
  })
})
