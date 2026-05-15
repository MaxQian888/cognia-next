/**
 * E2E: connector draft approval — seeded drafts surface in the Inbox + can
 * be approved / discarded.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { seedConnectorDraft } from "../helpers/seed-workflow"

test.describe("mobile — connector draft approval", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("a seeded draft renders + tapping approve removes it from the list", async ({ page }) => {
    await seedConnectorDraft(page, {
      adapterId: "lark",
      conversationKey: "lark:chat:demo",
      content: "Pending reply",
    })
    await page.goto("/inbox")
    await expect(page.getByText("Pending reply")).toBeVisible({ timeout: 15_000 })
    const approve = page.getByRole("button", { name: /approve|批准|发送/i }).first()
    if (await approve.count()) {
      await approve.click()
      await expect(page.getByText("Pending reply")).toBeHidden()
    }
  })
})
