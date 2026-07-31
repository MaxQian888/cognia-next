/**
 * E2E: alignment overlay surfaces snap guides when dragging a node.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../helpers/seed-workflow"

test.describe("workflow editor — alignment overlay", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("dragging a node toward another triggers vertical / horizontal guides", async ({ page }) => {
    await seedAndOpenWorkflow(page, "multi-step")
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()

    const target = page.getByTestId("wf-node-ai.prompt").first()
    const targetBox = await target.boundingBox()
    if (!targetBox) test.fail(true, "could not read target node bounding box")

    // Use the mouse API to drag the data.transform node into vertical alignment.
    const handle = page.getByTestId("wf-node-data.transform").first()
    const hBox = await handle.boundingBox()
    if (!hBox || !targetBox) return

    await page.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(targetBox.x + targetBox.width / 2 + 2, hBox.y + 1, { steps: 12 })
    // Mid-drag, at least one alignment guide should be visible.
    await expect(page.getByTestId(/alignment-guide-/).first()).toBeVisible({ timeout: 5_000 })
    await page.mouse.up()
  })
})
