/**
 * E2E: action.plugin.invoke — Phase 6+ stub. Editor + form only.
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

test.describe("workflow node — action.plugin.invoke (stub)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded plugin invoke renders + pluginId + capability + args fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-plugin-invoke")
    await assertNodeOnCanvas(page, { kind: "action.plugin.invoke", label: "Plugin" })
    await openNodeInspector(page, "action.plugin.invoke")
    await expect(page.locator("#ins-pluginId, [data-field=pluginId]").first()).toBeVisible()
    await expect(page.locator("#ins-toolName, [data-field=toolName]").first()).toBeVisible()
    await expect(page.locator("#ins-argsJson, [data-field=argsJson]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.plugin.invoke" })
  })
})
