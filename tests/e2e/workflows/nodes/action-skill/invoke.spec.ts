/**
 * E2E: action.skill.invoke — invokes a registered skill by id.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow, seedSkill } from "../../../helpers/seed-workflow"
import {
  assertLatestRunStatus,
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
  triggerRun,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.skill.invoke", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded skill invoke renders + skillId + input persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-skill-invoke")
    await assertNodeOnCanvas(page, { kind: "action.skill.invoke", label: "Invoke" })
    await openNodeInspector(page, "action.skill.invoke")
    await expect(page.locator("#ins-skillId, [name=skillId]").first()).toBeVisible()
    await expect(page.locator("#ins-input, [name=input]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.skill.invoke" })
  })

  test("manual run resolves through the seeded skill", async ({ page }) => {
    await seedSkill(page, { name: "E2E Skill", trigger: "manual", body: "noop" })
    const wfId = await seedAndOpenWorkflow(page, "action-skill-invoke")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
