/**
 * E2E: action.desktop.readTree — editor + form persistence.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.desktop.readTree", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded readTree renders + rootHandle + maxDepth fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-desktop-read-tree")
    await assertNodeOnCanvas(page, { kind: "action.desktop.readTree", label: "Tree" })
    await openNodeInspector(page, "action.desktop.readTree")
    await expect(page.locator("#ins-selector, [data-field=selector]").first()).toBeVisible()
    await expect(page.locator("#ins-maxDepth, [data-field=maxDepth]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.desktop.readTree" })
  })
})
