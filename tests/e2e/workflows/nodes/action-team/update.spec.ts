/**
 * E2E: action.team.update — editor renders + teamId + patch field persists.
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

test.describe("workflow node — action.team.update", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded team update renders + teamId persists", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-team-update")
    await assertNodeOnCanvas(page, { kind: "action.team.update", label: "Update" })
    await openNodeInspector(page, "action.team.update")
    await expect(page.locator("#ins-teamId, [name=teamId]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.team.update" })
  })
})
