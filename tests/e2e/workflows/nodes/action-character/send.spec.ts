/**
 * E2E: action.character.send — Phase 6+ stub. Editor + form validation only.
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

test.describe("workflow node — action.character.send (stub)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded character send renders + characterId + content persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-character-send")
    await assertNodeOnCanvas(page, { kind: "action.character.send", label: "Send" })
    await openNodeInspector(page, "action.character.send")
    await expect(page.locator("#ins-characterId, [data-field=characterId]").first()).toBeVisible()
    await expect(page.locator("#ins-content, [data-field=content]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.character.send" })
  })
})
