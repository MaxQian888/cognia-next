/**
 * E2E: mobile chat surface — composer + scroll + send.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — chat surface", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("composer is reachable + send button enables once text is present", async ({ page }) => {
    const composer = page.getByRole("textbox", { name: /message/i }).first()
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill("Hello from mobile")
    const sendBtn = page.getByRole("button", { name: /send|发送/i }).first()
    await expect(sendBtn).toBeEnabled()
  })
})
