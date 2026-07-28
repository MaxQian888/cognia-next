/**
 * E2E: workflow library filters by name when the search box is used.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedWorkflow } from "../../helpers/seed-workflow"

test.describe("workflow editor — library search", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("typing in the search input filters down to matching cards", async ({ page }) => {
    await seedWorkflow(page, "manual-ai")
    await seedWorkflow(page, "branch")
    await seedWorkflow(page, "ai-prompt")

    await page.goto("/workflows")
    const search = page.getByPlaceholder(/search/i).first()
    await expect(search).toBeVisible()
    await search.fill("Branch")
    await expect(page.getByText("E2E Branch")).toBeVisible()
    await expect(page.getByText("E2E Manual → AI")).toBeHidden()
  })
})
