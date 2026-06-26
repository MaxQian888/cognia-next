/**
 * E2E: trigger.github.webhook — repo binding + events array + secret.
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

test.describe("workflow node — trigger.github.webhook", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded github webhook trigger renders + repo + events + secret persist", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "trigger-github-webhook")
    await assertNodeOnCanvas(page, { kind: "trigger.github.webhook", label: "GitHub Webhook" })
    await openNodeInspector(page, "trigger.github.webhook")
    await expect(page.locator("#ins-repoFullName, [data-field=repoFullName]").first()).toBeVisible()
    await expect(page.locator("#ins-events, [data-field=events]").first()).toBeVisible()
    await expect(page.locator("#ins-hmacSecret, [data-field=hmacSecret]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "trigger.github.webhook" })
  })
})
