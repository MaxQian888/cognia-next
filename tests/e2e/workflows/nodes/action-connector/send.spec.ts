/**
 * E2E: action.connector.send — enqueues an outbound row that the runner
 * dispatches via the mock Lark server.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { configureMockBaseUrls, seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertLatestRunStatus,
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
  triggerRun,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.connector.send", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { lark: process.env.E2E_LARK_BASE_URL! })
  })

  test("seeded connector send renders + adapter + conversation + content persist", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-connector-send")
    await assertNodeOnCanvas(page, { kind: "action.connector.send", label: "Send" })
    await openNodeInspector(page, "action.connector.send")
    await expect(page.locator("#ins-adapterId, [data-field=adapterId]").first()).toBeVisible()
    await expect(
      page.locator("#ins-conversationKey, [data-field=conversationKey]").first()
    ).toBeVisible()
    await expect(page.locator("#ins-content, [data-field=content]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.connector.send" })
  })

  test("manual run enqueues an outbound job", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-connector-send")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
