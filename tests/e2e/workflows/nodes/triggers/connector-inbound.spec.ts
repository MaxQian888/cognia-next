/**
 * E2E: trigger.connector.inbound — adapter binding + filter pattern.
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

test.describe("workflow node — trigger.connector.inbound", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded connector inbound trigger renders + adapter + filter persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "trigger-connector-inbound")
    await assertNodeOnCanvas(page, {
      kind: "trigger.connector.inbound",
      label: "Connector Inbound",
    })
    await openNodeInspector(page, "trigger.connector.inbound")
    await expect(page.locator("#ins-adapterId, [data-field=adapterId]").first()).toBeVisible()
    await expect(
      page.locator("#ins-conversationKey, [data-field=conversationKey]").first()
    ).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "trigger.connector.inbound" })
  })
})
