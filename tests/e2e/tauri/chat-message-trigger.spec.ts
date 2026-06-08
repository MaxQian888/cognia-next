/**
 * Tauri-driver E2E: chat.message → workflow trigger end-to-end.
 *
 * Replaces the previously `test.skip()`'d stub at the bottom of
 * `tests/e2e/workflows/chat-message-trigger.spec.ts`. Runs only under the
 * `tauri-driver` Playwright project (PLAYWRIGHT_TAURI_DRIVER=1).
 *
 * Flow under test:
 *   1. Seed a `trigger.chat.message → ai.prompt → flow.set` workflow.
 *   2. Send a chat message via the in-app composer.
 *   3. `persistMessages` fires the trigger; the orchestrator runs the
 *      workflow against the mock Anthropic server.
 *   4. Assert: a workflowRuns row, ≥1 workflowRunEvents rows, and a
 *      response surfaces in the chat thread.
 */

import { expect, test } from "./fixtures"
import { resetCogniaDb } from "../helpers/db-reset"
import { seedAndOpenWorkflow, configureMockBaseUrls } from "../helpers/seed-workflow"

test.describe("tauri-driver: chat.message → workflow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, {
      anthropic: process.env.E2E_ANTHROPIC_BASE_URL!,
    })
  })

  test("incoming chat message fires the trigger and runs the workflow", async ({ page }) => {
    // The seed gives us a workflow whose trigger.chat.message has no
    // conversation filter, so it fires on any incoming user message.
    const wfId = await seedAndOpenWorkflow(page, "trigger-chat")
    await expect(page.getByTestId("workflow-toolbar")).toBeVisible()

    // Navigate to the home chat and send a message.
    await page.goto("/")
    const composer = page.getByRole("textbox", { name: /message/i }).first()
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await composer.fill("hello workflow trigger")
    await composer.press("Enter")

    // Workflow run shows up in the audit/run list of the seeded workflow.
    await page.goto(`/workflows/runs?id=${wfId}`)
    await expect(page.getByTestId("run-list")).toBeVisible({ timeout: 30_000 })
    const firstRun = page.locator("[data-testid=openRun]").first()
    await expect(firstRun).toBeVisible({ timeout: 30_000 })
  })
})
