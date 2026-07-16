/**
 * E2E: action.team.run — Phase 6+ stub. Editor + form validation only.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertNodeOnCanvas,
  expectInspectorFieldValue,
  fillInspectorField,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.team.run (stub)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded team run renders + goal round-trips through save/reload", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-team-run")
    await assertNodeOnCanvas(page, { kind: "action.team.run", label: "Run" })
    await openNodeInspector(page, "action.team.run")
    await expect(page.locator("#ins-teamId, [data-field=teamId]").first()).toBeVisible()
    await expect(page.locator("#ins-goal, [data-field=goal]").first()).toBeVisible()
    await fillInspectorField(page, "goal", "e2e round-trip goal")
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.team.run" })
    // The reload must bring the edited VALUE back, not just the node
    // shell — this is the half no node spec asserted before.
    await openNodeInspector(page, "action.team.run")
    await expectInspectorFieldValue(page, "goal", "e2e round-trip goal")
  })
})
