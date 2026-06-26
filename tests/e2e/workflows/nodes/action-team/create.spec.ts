/**
 * E2E: action.team.create — real executor writes a Dexie teams row.
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

test.describe("workflow node — action.team.create", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded team create renders + name + description persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-team-create")
    await assertNodeOnCanvas(page, { kind: "action.team.create", label: "Create" })
    await openNodeInspector(page, "action.team.create")
    await expect(page.locator("#ins-name, [data-field=name]").first()).toBeVisible()
    await expect(page.locator("#ins-description, [data-field=description]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.team.create" })
  })

  test("manual run creates a Dexie teams row", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-team-create")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
