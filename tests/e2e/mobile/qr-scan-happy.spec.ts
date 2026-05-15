/**
 * E2E: QR scan happy path — pair via cgnp2 payload.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

const PAIR_PAYLOAD =
  "cgnp2|" +
  Buffer.from(
    JSON.stringify({
      baseUrl: "https://10.0.0.5:7891",
      pairJwt: "pj.pj.pj",
      version: 2,
      fingerprint: "abcdef",
    })
  ).toString("base64url")

test.describe("mobile — QR scan (happy path)", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android", barcodeResult: { rawValue: PAIR_PAYLOAD } })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("scanning a valid pair payload advances the pair flow to step 3", async ({ page }) => {
    await page.goto("/pair")
    await page
      .getByRole("button", { name: /scan|扫码/i })
      .first()
      .click()
    // Mock scan completes; the flow should advance past step 2.
    await expect(page.locator("[data-step=3], [data-pair-step=paired]").first()).toBeVisible({
      timeout: 15_000,
    })
  })
})
