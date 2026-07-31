/**
 * E2E: the workflow library create dialog validates name + lands in editor.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"

test.describe("workflow editor — create dialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("submitting the dialog creates a workflow + navigates to the editor", async ({ page }) => {
    await page.goto("/workflows")
    await page.getByTestId("workflow-create").click()
    await page.locator("#wf-name").fill("From Dialog E2E")
    await page.locator("#wf-desc").fill("created from the dialog")
    await page.getByRole("button", { name: /create/i }).click()
    await page.waitForURL(/\/workflows\/[^/]+$/)
    await expect(page.getByTestId("workflow-toolbar")).toBeVisible()
  })

  test("trying to create with an empty name surfaces an inline error", async ({ page }) => {
    await page.goto("/workflows")
    await page.getByTestId("workflow-create").click()
    await page.locator("#wf-name").fill("")
    await page.getByRole("button", { name: /create/i }).click()
    await expect(page.getByText(/name.*required|required.*name/i)).toBeVisible()
  })
})
