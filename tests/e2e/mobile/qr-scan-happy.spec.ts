/**
 * E2E: QR scan happy path — pair via a canonical cgnp3 Owner invitation.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { createOwnerPairPayload } from "./companion-fixture"

test.describe("mobile — QR scan (happy path)", () => {
  test("scanning a valid pair payload registers and advances to the paired step", async ({
    page,
  }) => {
    const baseUrl = process.env.E2E_V2_BASE_URL
    if (!baseUrl) throw new Error("the Companion E2E mock was not started")
    await injectCapacitor(page, {
      platform: "android",
      barcodeResult: { rawValue: createOwnerPairPayload(baseUrl) },
    })
    await page.goto("/")
    await resetCogniaDb(page)
    await page.goto("/pair")
    await page
      .getByRole("button", { name: /scan|扫码/i })
      .first()
      .click()
    await expect(page.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "paired", {
      timeout: 15_000,
    })
  })
})
