/**
 * E2E: action.character.update — editor renders + patch field persists.
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

test.describe("workflow node — action.character.update", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded update node renders + characterId + patch persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-character-update")
    await assertNodeOnCanvas(page, { kind: "action.character.update", label: "Update" })
    await openNodeInspector(page, "action.character.update")
    await expect(page.locator("#ins-characterId, [data-field=characterId]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.character.update" })
  })
})
