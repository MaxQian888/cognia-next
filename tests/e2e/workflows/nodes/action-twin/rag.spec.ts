/**
 * Editor contract for action.twin.rag: form fields and durable graph state.
 * The executor is implemented in lib/workflow/nodes/integrations/index.ts.
 * These assertions do not claim runtime or real-provider acceptance.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.twin.rag — editor persistence", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded twin rag renders + twinId + query fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-twin-rag")
    await assertNodeOnCanvas(page, { kind: "action.twin.rag", label: "RAG" })
    await openNodeInspector(page, "action.twin.rag")
    await expect(page.locator("#ins-twinId, [data-field=twinId]").first()).toBeVisible()
    await expect(page.locator("#ins-query, [data-field=query]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.twin.rag" })
  })
})
