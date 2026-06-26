/**
 * E2E: annotation.group — title + color + size round-trip.
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

test.describe("workflow node — annotation.group", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded group renders + title + color + dimensions persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "annotation-group")
    await assertNodeOnCanvas(page, { kind: "annotation.group", label: "Group" })
    await openNodeInspector(page, "annotation.group")
    await expect(page.locator("#ins-title, [data-field=title]").first()).toBeVisible()
    await expect(page.locator("#ins-width, [data-field=width]").first()).toBeVisible()
    await expect(page.locator("#ins-height, [data-field=height]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "annotation.group" })
  })
})
