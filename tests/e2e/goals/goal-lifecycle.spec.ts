/**
 * Browser E2E: Goals product lifecycle.
 *
 * This owns the portable management contract on `/goals`: create through the
 * real quick-create UI, observe the open goal, pause it, verify the persisted
 * lifecycle audit in the inspector, restore the paused state after a full
 * reload, then resume and stop it (through the stop confirmation) into
 * durable history. It deliberately does not fake an LLM turn or judge result;
 * model-driven progress belongs to the runtime harness.
 *
 * Runs at the default desktop viewport, so a selected goal opens as the
 * console's inspector pane (`GoalDetailPanel`) beside the list, not a sheet.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb, waitForTestGlobals } from "../helpers/db-reset"

const OBJECTIVE = "Keep the release checklist current and verifiable"

test.describe("goals — product lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await page.goto("about:blank")
    await page.goto("/goals", { waitUntil: "domcontentloaded" })
    await waitForTestGlobals(page, 30_000)
    await expect(page.getByTestId("goal-console")).toBeVisible()
  })

  test("@critical creates, pauses, restores, resumes, and stops a goal", async ({ page }) => {
    await page.getByTestId("goal-console-header").getByTestId("goal-quick-create-trigger").click()

    const createDialog = page.getByTestId("goal-quick-create-dialog")
    await createDialog.getByTestId("goal-quick-create-objective").fill(OBJECTIVE)
    await createDialog.getByTestId("goal-quick-create-submit").click()

    // Creating a goal opens the new conversation the loop runs in.
    await expect(page).toHaveURL(/\/\?session=[^&]+$/)
    await page.goBack({ waitUntil: "domcontentloaded" })
    await expect(page).toHaveURL(/\/goals$/)

    const goalRow = page.getByTestId("goal-list-row").filter({ hasText: OBJECTIVE })
    await expect(goalRow).toHaveCount(1)
    await expect(goalRow.getByTestId("goal-status-chip")).toHaveAttribute("data-status", "active")
    await goalRow.getByTestId("goal-control-pause").click()

    await expect(goalRow.getByTestId("goal-status-chip")).toHaveAttribute("data-status", "paused")
    await expect(goalRow.getByTestId("goal-control-resume")).toBeVisible()
    await expect(goalRow.getByTestId("goal-control-pause")).toHaveCount(0)

    // Selecting the row opens it in the inspector and puts it in the address.
    await goalRow.getByTestId("goal-list-row-select").click()
    await expect(page).toHaveURL(/[?&]goal=/)
    const inspector = page.getByTestId("goal-detail-panel")
    await expect(inspector).toBeVisible()
    await expect(inspector).toContainText(OBJECTIVE)
    await inspector.getByTestId("goal-tab-activity").click()

    const activity = inspector.getByTestId("goal-activity-list")
    await expect(activity.locator('[data-kind="goal_created"]')).toHaveCount(1)
    await expect(activity).toContainText("Goal created")
    await expect(activity.locator('[data-kind="user_paused"]')).toHaveCount(1, {
      timeout: 20_000,
    })
    await expect(activity).toContainText("Paused")
    await expect(activity).toContainText("User paused")

    // Closing the inspector clears the selection from the address.
    await inspector.getByTestId("goal-detail-close").click()
    await expect(inspector).toHaveCount(0)
    await expect(page).not.toHaveURL(/[?&]goal=/)

    await page.reload({ waitUntil: "domcontentloaded" })

    const restoredRow = page.getByTestId("goal-list-row").filter({ hasText: OBJECTIVE })
    await expect(restoredRow).toHaveCount(1)
    await expect(restoredRow.getByTestId("goal-status-chip")).toHaveAttribute(
      "data-status",
      "paused"
    )
    await restoredRow.getByTestId("goal-control-resume").click()
    await expect(restoredRow.getByTestId("goal-status-chip")).toHaveAttribute(
      "data-status",
      "active"
    )

    // Stop is terminal, so it asks first.
    await restoredRow.getByTestId("goal-control-stop").click()
    const stopConfirm = page.getByTestId("goal-stop-confirm")
    await expect(stopConfirm).toBeVisible()
    await expect(stopConfirm).toContainText(OBJECTIVE)
    await stopConfirm.getByTestId("goal-stop-confirm-action").click()

    await expect(restoredRow).toHaveCount(0)
    await page.getByTestId("goal-console-tab-history").click()
    await expect(page).toHaveURL(/[?&]tab=history/)
    const historyRow = page.getByTestId("goals-history-row").filter({ hasText: OBJECTIVE })
    await expect(historyRow).toHaveCount(1)
    await expect(historyRow.getByTestId("goal-status-chip")).toHaveAttribute(
      "data-status",
      "stopped"
    )
    await expect(historyRow.getByTestId("goal-status-chip")).toContainText("stopped")
  })
})
