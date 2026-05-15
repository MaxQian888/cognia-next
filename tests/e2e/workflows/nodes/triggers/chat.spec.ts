/**
 * E2E: trigger.chat.message — conversation filter + pattern.
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

test.describe("workflow node — trigger.chat.message", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded chat trigger renders + filter fields persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "trigger-chat")
    await assertNodeOnCanvas(page, { kind: "trigger.chat.message", label: "Chat" })
    await openNodeInspector(page, "trigger.chat.message")
    await expect(page.locator("#ins-conversationKey, [name=conversationKey]").first()).toBeVisible()
    await expect(page.locator("#ins-filterPattern, [name=filterPattern]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "trigger.chat.message" })
  })
})
