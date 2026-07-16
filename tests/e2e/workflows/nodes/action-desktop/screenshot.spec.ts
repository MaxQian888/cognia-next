/**
 * E2E: action.desktop.screenshot — editor + form persistence. Runtime is
 * Tauri-only; the desktop-runtime path is covered by lib/workflow/nodes/desktop.test.ts.
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

test.describe("workflow node — action.desktop.screenshot", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded screenshot renders + region fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-desktop-screenshot")
    await assertNodeOnCanvas(page, { kind: "action.desktop.screenshot", label: "Screenshot" })
    await openNodeInspector(page, "action.desktop.screenshot")
    await expect(page.locator("#ins-selector, [data-field=selector]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.desktop.screenshot" })
  })
})
