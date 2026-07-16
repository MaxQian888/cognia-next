/**
 * E2E: action.desktop.type — editor + form persistence.
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

test.describe("workflow node — action.desktop.type", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded type renders + text round-trips through save/reload", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-desktop-type")
    await assertNodeOnCanvas(page, { kind: "action.desktop.type", label: "Type" })
    await openNodeInspector(page, "action.desktop.type")
    await expect(page.locator("#ins-text, [data-field=text]").first()).toBeVisible()
    await fillInspectorField(page, "text", "typed by e2e round-trip")
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.desktop.type" })
    // The reload must bring the edited VALUE back, not just the node
    // shell — this is the half no node spec asserted before.
    await openNodeInspector(page, "action.desktop.type")
    await expectInspectorFieldValue(page, "text", "typed by e2e round-trip")
  })
})
