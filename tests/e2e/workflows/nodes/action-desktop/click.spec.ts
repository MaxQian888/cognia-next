/**
 * E2E: action.desktop.click — editor + form persistence.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
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

test.describe("workflow node — action.desktop.click", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded click renders + selector round-trips through save/reload", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-desktop-click")
    await assertNodeOnCanvas(page, { kind: "action.desktop.click", label: "Click" })
    await openNodeInspector(page, "action.desktop.click")
    await expect(page.locator("#ins-selector, [data-field=selector]").first()).toBeVisible()
    await expect(page.locator("#ins-button, [data-field=button]").first()).toBeVisible()
    await fillInspectorField(page, "selector", "#e2e-roundtrip-target")
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.desktop.click" })
    // The reload must bring the edited VALUE back, not just the node
    // shell — this is the half no node spec asserted before.
    await openNodeInspector(page, "action.desktop.click")
    await expectInspectorFieldValue(page, "selector", "#e2e-roundtrip-target")
  })
})
