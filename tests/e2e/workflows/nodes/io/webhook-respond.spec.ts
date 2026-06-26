/**
 * E2E: io.webhook.respond — sets HTTP response when a workflow is fired by
 * a `trigger.webhook`. We exercise editor + saved params only here; the
 * full webhook round-trip lives in the tauri-driver project.
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

test.describe("workflow node — io.webhook.respond", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded io.webhook.respond renders + statusCode + body persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "io-webhook-respond")
    await assertNodeOnCanvas(page, { kind: "io.webhook.respond", label: "Respond" })
    await openNodeInspector(page, "io.webhook.respond")
    await expect(page.locator("#ins-status, [data-field=status]").first()).toBeVisible()
    await expect(page.locator("#ins-body, [data-field=body]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "io.webhook.respond" })
  })
})
