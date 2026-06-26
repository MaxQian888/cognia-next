/**
 * E2E: action.twin.rag — Phase 6+ stub. Editor + form validation only.
 * Runtime RAG path is covered by lib/twin unit tests + the goal-loop spec.
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

test.describe("workflow node — action.twin.rag (stub)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded twin rag renders + twinId + query persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-twin-rag")
    await assertNodeOnCanvas(page, { kind: "action.twin.rag", label: "RAG" })
    await openNodeInspector(page, "action.twin.rag")
    await expect(page.locator("#ins-twinId, [data-field=twinId]").first()).toBeVisible()
    await expect(page.locator("#ins-query, [data-field=query]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.twin.rag" })
  })
})
