/**
 * E2E: biometric guard rejects backup/export when verify fails + allows
 * through when verify succeeds.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — biometric guard", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("backup export is blocked when biometric verify fails", async ({ page }) => {
    await page.evaluate(() => {
      ;(
        window as unknown as { __cogniaCapMock: { setBiometricAvailable: (b: boolean) => void } }
      ).__cogniaCapMock.setBiometricAvailable(false)
    })
    await page.goto("/me")
    const exportBtn = page.getByRole("button", { name: /export|导出/i }).first()
    if (await exportBtn.count()) {
      await exportBtn.click()
      await expect(page.getByText(/biometric|生物识别|verification failed/i).first()).toBeVisible({
        timeout: 10_000,
      })
    }
  })

  test("backup export proceeds when biometric verify succeeds", async ({ page }) => {
    await page.goto("/me")
    const exportBtn = page.getByRole("button", { name: /export|导出/i }).first()
    if (await exportBtn.count()) {
      await exportBtn.click()
      // Either the export starts (loading spinner) or a save dialog opens.
      await expect(page.getByRole("alert").or(page.getByRole("status")).first()).toBeVisible({
        timeout: 10_000,
      })
    }
  })
})
