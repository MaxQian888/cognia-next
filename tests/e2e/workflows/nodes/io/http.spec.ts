/**
 * E2E: io.http — HTTP request executor against an in-test fetch route.
 */

import { expect, test } from "@playwright/test"
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

test.describe("workflow node — io.http", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    // Intercept the test URL so the executor's network call is observable
    // and deterministic.
    await page.route("https://example.test/data", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ hello: "world" }),
      })
    })
  })

  test("seeded io.http renders + method + url are editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "io-http")
    await assertNodeOnCanvas(page, { kind: "io.http", label: "HTTP" })
    await openNodeInspector(page, "io.http")
    await expect(page.locator("#ins-method, [data-field=method]").first()).toBeVisible()
    await expect(page.locator("#ins-url, [data-field=url]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "io.http" })
  })

  test("manual run resolves through the intercepted route", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "io-http")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
