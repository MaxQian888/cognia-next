/**
 * E2E: action.skill.upsert — creates or updates a skill via the executor.
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

test.describe("workflow node — action.skill.upsert", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded skill upsert renders + name + body persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-skill-upsert")
    await assertNodeOnCanvas(page, { kind: "action.skill.upsert", label: "Upsert" })
    await openNodeInspector(page, "action.skill.upsert")
    await expect(page.locator("#ins-name, [name=name]").first()).toBeVisible()
    await expect(page.locator("#ins-body, [name=body]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.skill.upsert" })
  })

  test("manual run upserts a Dexie skills row", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-skill-upsert")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
