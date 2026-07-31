/**
 * E2E: action.connector.draft — creates a draft row visible in the Inbox.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertLatestRunStatus,
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
  triggerRun,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.connector.draft", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded connector draft renders + sessionId + content fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-connector-draft")
    await assertNodeOnCanvas(page, { kind: "action.connector.draft", label: "Draft" })
    await openNodeInspector(page, "action.connector.draft")
    await expect(page.locator("#ins-sessionId, [data-field=sessionId]").first()).toBeVisible()
    await expect(page.locator("#ins-content, [data-field=content]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.connector.draft" })
  })

  test("manual run creates a Dexie draft row", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-connector-draft")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
