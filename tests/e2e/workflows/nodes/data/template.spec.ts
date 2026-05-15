/**
 * E2E: data.template — editor + runtime (handlebars-like rendering).
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertLatestRunStatus,
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
  triggerRun,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — data.template", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded data.template node renders + template field is editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "data-template")
    await assertNodeOnCanvas(page, { kind: "data.template", label: "Template" })
    await openNodeInspector(page, "data.template")
    await expect(page.locator("#ins-template, [name=template]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "data.template" })
  })

  test("manual run renders the template successfully", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "data-template")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
