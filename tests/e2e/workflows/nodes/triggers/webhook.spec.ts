/**
 * E2E: trigger.webhook — path + method + secret editing.
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

test.describe("workflow node — trigger.webhook", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded webhook trigger renders + path + method + secret fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "trigger-webhook")
    await assertNodeOnCanvas(page, { kind: "trigger.webhook", label: "Webhook" })
    await openNodeInspector(page, "trigger.webhook")
    await expect(page.locator("#ins-path, [data-field=path]").first()).toBeVisible()
    await expect(page.locator("#ins-method, [data-field=method]").first()).toBeVisible()
    await expect(page.locator("#ins-hmacSecret, [data-field=hmacSecret]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "trigger.webhook" })
  })
})
