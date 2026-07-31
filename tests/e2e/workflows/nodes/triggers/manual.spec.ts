/**
 * E2E: trigger.manual — present on every fixture; this spec asserts the
 * lone-trigger workflow still surfaces a Run button.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertLatestRunStatus,
  assertNodeOnCanvas,
  triggerRun,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — trigger.manual", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded manual trigger renders + Run button is enabled", async ({ page }) => {
    await seedAndOpenWorkflow(page, "flow-set")
    await assertNodeOnCanvas(page, { kind: "trigger.manual", label: "Manual" })
    await expect(page.getByTestId("workflow-run")).toBeEnabled()
  })

  test("a flow.set-only workflow runs to succeeded via the manual trigger", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "flow-set")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
