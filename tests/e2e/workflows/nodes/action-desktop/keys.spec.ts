/**
 * E2E: action.desktop.keys — editor + form persistence.
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

test.describe("workflow node — action.desktop.keys", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded keys renders + sequence persists", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-desktop-keys")
    await assertNodeOnCanvas(page, { kind: "action.desktop.keys", label: "Keys" })
    await openNodeInspector(page, "action.desktop.keys")
    await expect(page.locator("#ins-chord, [data-field=chord]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.desktop.keys" })
  })
})
