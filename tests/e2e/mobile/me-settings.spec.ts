/**
 * E2E: mobile Me page — account card, settings rows, and the unpaired CTA.
 *
 * Binds to real testids (me-page / account-card / me-row-*). An earlier
 * version asserted getByTestId("me-pairing-status") — a testid no product
 * code ever rendered — rescued by an `.or(getByText(/pairing/))` fallback.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb, setCogniaSettings } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — me page", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
    await setCogniaSettings(page, { mobileRuntimeMode: "standalone" })
  })

  test("renders account card, settings rows, and the pair CTA when unpaired", async ({
    page,
  }) => {
    await page.goto("/me")
    await expect(page.getByTestId("me-page")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("account-card")).toBeVisible()
    // Data-driven settings rows from me-entries.ts — profile is unconditional.
    await expect(page.getByTestId("me-row-profile")).toBeVisible()
    // A freshly reset device is unpaired → the account section offers /pair.
    await expect(page.getByTestId("me-row-pair")).toBeVisible()
  })
})
