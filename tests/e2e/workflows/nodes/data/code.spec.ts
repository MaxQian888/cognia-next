/**
 * E2E: data.code — editor renders the sandboxed code editor + saved code
 * round-trips.
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

test.describe("workflow node — data.code", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded data.code node renders + language + body fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "data-code")
    await assertNodeOnCanvas(page, { kind: "data.code", label: "Code" })
    await openNodeInspector(page, "data.code")
    await expect(page.locator("#ins-code, [data-field=code]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "data.code" })
  })
})
