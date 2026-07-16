/**
 * E2E: action.desktop.invokePattern — editor + form persistence.
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

test.describe("workflow node — action.desktop.invokePattern", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded invokePattern renders + elementHandle + pattern fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-desktop-invoke-pattern")
    await assertNodeOnCanvas(page, { kind: "action.desktop.invokePattern", label: "Invoke" })
    await openNodeInspector(page, "action.desktop.invokePattern")
    await expect(page.locator("#ins-selector, [data-field=selector]").first()).toBeVisible()
    await expect(page.locator("#ins-pattern, [data-field=pattern]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.desktop.invokePattern" })
  })
})
