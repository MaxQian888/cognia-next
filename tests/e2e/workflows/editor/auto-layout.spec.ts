/**
 * E2E: auto-layout toolbar action repositions nodes deterministically.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../helpers/seed-workflow"

test.describe("workflow editor — auto-layout", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("clicking auto-layout updates each node's transform style", async ({ page }) => {
    await seedAndOpenWorkflow(page, "multi-step")
    const promptNode = page.getByTestId("wf-node-ai.prompt").first()
    await expect(promptNode).toBeVisible()
    const before = await promptNode.evaluate((el) => (el as HTMLElement).style.transform)

    await page.getByTestId("workflow-auto-layout").click()
    await expect
      .poll(async () => promptNode.evaluate((el) => (el as HTMLElement).style.transform))
      .not.toBe(before)
  })
})
