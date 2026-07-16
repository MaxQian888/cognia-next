/**
 * E2E: action.twin.ingest — Phase 6+ stub. Editor + form validation only.
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

test.describe("workflow node — action.twin.ingest (stub)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded twin ingest renders + twinId + sourceUrl fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-twin-ingest")
    await assertNodeOnCanvas(page, { kind: "action.twin.ingest", label: "Ingest" })
    await openNodeInspector(page, "action.twin.ingest")
    await expect(page.locator("#ins-twinId, [data-field=twinId]").first()).toBeVisible()
    await expect(page.locator("#ins-url, [data-field=url]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.twin.ingest" })
  })
})
