/**
 * E2E: action.desktop.click — editor + form persistence.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.desktop.click", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded click renders + elementHandle + button persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-desktop-click")
    await assertNodeOnCanvas(page, { kind: "action.desktop.click", label: "Click" })
    await openNodeInspector(page, "action.desktop.click")
    await expect(page.locator("#ins-selector, [data-field=selector]").first()).toBeVisible()
    await expect(page.locator("#ins-button, [data-field=button]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.desktop.click" })
  })
})
