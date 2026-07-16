/**
 * E2E: trigger.cron — schedule registration + timezone editor.
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

test.describe("workflow node — trigger.cron", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded cron trigger renders + schedule + timezone fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "trigger-cron")
    await assertNodeOnCanvas(page, { kind: "trigger.cron", label: "Cron" })
    await openNodeInspector(page, "trigger.cron")
    await expect(page.locator("#ins-cron, [data-field=cron]").first()).toBeVisible()
    await expect(page.locator("#ins-timezone, [data-field=timezone]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "trigger.cron" })
  })
})
