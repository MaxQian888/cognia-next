/**
 * E2E: mobile Me page — settings overview + pairing status card.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — me page", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("renders pairing status card + at least one settings link", async ({ page }) => {
    await page.goto("/me")
    await expect(
      page.getByTestId("me-pairing-status").or(page.getByText(/pairing|配对/i))
    ).toBeVisible({ timeout: 15_000 })
  })
})
