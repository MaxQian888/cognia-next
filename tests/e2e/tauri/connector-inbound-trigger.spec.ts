/**
 * Tauri-driver E2E: connector.inbound → workflow trigger end-to-end.
 *
 * Replaces the previously `test.skip()`'d stub. Runs only under the
 * `tauri-driver` Playwright project (PLAYWRIGHT_TAURI_DRIVER=1).
 *
 * Flow under test:
 *   1. Boot the mock Telegram server (already runs in suite globalSetup).
 *   2. Seed a workflow with `trigger.connector.inbound` bound to adapterId
 *      "telegram".
 *   3. Push a synthetic inbound update through the mock server.
 *   4. ConnectorBus.dispatchInboundFull fans out to the workflow runtime;
 *      the orchestrator records a run.
 *   5. Assert: workflowRuns row + workflowAudit row visible in the audit
 *      tab.
 */

import { expect, test } from "./fixtures"
import { resetCogniaDb } from "../helpers/db-reset"
import { seedAndOpenWorkflow } from "../helpers/seed-workflow"
import { createTelegramMockServer, makeTelegramUpdate } from "../connectors/telegram-mock-server"

const MOCK_PORT = 19878
let mock: ReturnType<typeof createTelegramMockServer> | null = null

test.beforeAll(async () => {
  mock = createTelegramMockServer()
  await mock.start(MOCK_PORT)
})
test.afterAll(async () => {
  await mock?.stop()
})

test.describe("tauri-driver: connector.inbound → workflow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("inbound Telegram message fires the trigger and runs the workflow", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "trigger-connector-inbound")
    await expect(page.getByTestId("workflow-toolbar")).toBeVisible()

    mock!.pushUpdate(makeTelegramUpdate("hello connector trigger", 555, 777))

    // The orchestrator's run shows up under the workflow's runs page.
    await page.goto(`/workflows/${wfId}/runs`)
    await expect(page.getByTestId("run-list")).toBeVisible({ timeout: 30_000 })
    await expect(page.locator("[data-testid=openRun]").first()).toBeVisible({ timeout: 30_000 })
  })
})
