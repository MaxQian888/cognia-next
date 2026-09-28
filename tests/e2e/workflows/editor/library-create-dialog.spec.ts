/**
 * E2E: the workflow library create dialog persists names and opens the editor.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { readDexieRow, resetCogniaDb } from "../../helpers/db-reset"

test.describe("workflow editor — create dialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("submitting the dialog creates a workflow + navigates to the editor", async ({ page }) => {
    await page.goto("/workflows")
    await page.getByRole("button", { name: "New workflow", exact: true }).click()
    await page.locator("#wf-name").fill("From Dialog E2E")
    await page.locator("#wf-desc").fill("created from the dialog")
    await page.getByRole("button", { name: /create/i }).click()
    await page.waitForURL(/\/workflows\/editor\?id=/)
    await expect(page.getByTestId("workflow-toolbar")).toBeVisible()
  })

  test("an empty name creates a workflow with the displayed default title", async ({ page }) => {
    await page.goto("/workflows")
    await page.getByRole("button", { name: "New workflow", exact: true }).click()
    await page.locator("#wf-name").fill("")
    await page.getByRole("button", { name: /create/i }).click()
    await page.waitForURL(/\/workflows\/editor\?id=/)
    await expect(page.getByRole("textbox", { name: "Workflow name", exact: true })).toHaveValue(
      "Untitled workflow"
    )
    const workflowId = new URL(page.url()).searchParams.get("id")
    expect(workflowId).toBeTruthy()
    await expect(
      readDexieRow(page, { table: "workflows", key: workflowId! })
    ).resolves.toMatchObject({ id: workflowId, name: "Untitled workflow" })
  })
})
