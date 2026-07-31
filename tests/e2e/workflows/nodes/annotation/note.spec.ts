/**
 * E2E: annotation.note — color picker + text round-trip.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — annotation.note", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded note renders + text + color fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "annotation-note")
    await assertNodeOnCanvas(page, { kind: "annotation.note", label: "Note" })
    await openNodeInspector(page, "annotation.note")
    await expect(page.locator("#ins-text, [data-field=text]").first()).toBeVisible()
    // The color picker uses radio buttons with `data-testid=note-color-<value>`.
    await expect(page.getByTestId(/note-color-/).first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "annotation.note" })
  })

  test("changing the color value flips the selected radio", async ({ page }) => {
    await seedAndOpenWorkflow(page, "annotation-note")
    await openNodeInspector(page, "annotation.note")
    const blue = page.getByTestId("note-color-blue").first()
    await blue.click()
    await expect(blue).toBeChecked()
  })
})
