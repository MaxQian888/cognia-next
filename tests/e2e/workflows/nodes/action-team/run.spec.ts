/**
 * E2E: action.team.run — Phase 6+ stub. Editor + form validation only.
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

test.describe("workflow node — action.team.run (stub)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded team run renders + teamId + prompt persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-team-run")
    await assertNodeOnCanvas(page, { kind: "action.team.run", label: "Run" })
    await openNodeInspector(page, "action.team.run")
    await expect(page.locator("#ins-teamId, [name=teamId]").first()).toBeVisible()
    await expect(page.locator("#ins-prompt, [name=prompt]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.team.run" })
  })
})
