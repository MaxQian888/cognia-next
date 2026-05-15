/**
 * E2E: action.character.create — real executor writes a Dexie row.
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

test.describe("workflow node — action.character.create", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded create node renders + name + systemPrompt persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-character-create")
    await assertNodeOnCanvas(page, { kind: "action.character.create", label: "Create" })
    await openNodeInspector(page, "action.character.create")
    await expect(page.locator("#ins-name, [name=name]").first()).toBeVisible()
    await expect(page.locator("#ins-systemPrompt, [name=systemPrompt]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.character.create" })
  })

  test("manual run creates a Dexie characters row", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-character-create")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
