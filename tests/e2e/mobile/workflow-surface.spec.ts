/**
 * E2E: mobile workflow surface — list + run trigger.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { seedWorkflow } from "../helpers/seed-workflow"

test.describe("mobile — workflow surface", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("workflow library lists seeded workflows + supports manual trigger", async ({ page }) => {
    const wfId = await seedWorkflow(page, "manual-ai")
    await page.goto("/workflows")
    await expect(page.getByText("E2E Manual → AI")).toBeVisible({ timeout: 15_000 })
    await page.goto(`/workflows/editor?id=${wfId}`)
    await expect(page.getByTestId("workflow-toolbar")).toBeVisible()
  })
})
