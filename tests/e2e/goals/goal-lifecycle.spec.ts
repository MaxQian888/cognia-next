/**
 * Browser E2E: Goals product lifecycle.
 *
 * This owns the portable management contract on `/goals`: create through the
 * real quick-create UI, observe the open goal, pause it, verify the persisted
 * lifecycle audit, restore the paused state after a full reload, then resume
 * and stop it into durable history. It deliberately does not fake an LLM turn
 * or judge result; model-driven progress belongs to the runtime harness.
 */

import { expect, test } from "@playwright/test"
import { ensureCogniaAccount, waitForTestGlobals } from "../helpers/db-reset"

const OBJECTIVE = "Keep the release checklist current and verifiable"

test.describe("goals — product lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/goals", { waitUntil: "domcontentloaded" })
    await waitForTestGlobals(page, 30_000)
    await expect(page.getByTestId("goal-console")).toBeVisible()
  })

  test("creates, pauses, restores, resumes, and stops a goal", async ({ page }) => {
    const consoleHeader = page.getByTestId("goal-console").locator("header")
    await consoleHeader.getByTestId("goal-quick-create-trigger").click()

    const createDialog = page.getByTestId("goal-quick-create-dialog")
    await createDialog.getByTestId("goal-quick-create-objective").fill(OBJECTIVE)
    await createDialog.getByTestId("goal-quick-create-submit").click()

    await expect(page).toHaveURL(/\/$/)
    await page.goBack({ waitUntil: "domcontentloaded" })
    await expect(page).toHaveURL(/\/goals$/)

    const goalCard = page.getByTestId("active-goal-card").filter({ hasText: OBJECTIVE })
    await expect(goalCard).toHaveCount(1)
    await expect(goalCard).toContainText("active")
    await goalCard.getByTestId("active-card-pause").click()

    await expect(goalCard).toContainText("paused")
    await expect(goalCard.getByTestId("active-card-resume")).toBeVisible()
    await goalCard.getByTestId("active-card-details").click()
    await page.getByTestId("goal-tab-activity").click()

    const activity = page.getByTestId("goal-activity-list")
    await expect(activity).toContainText("goal_created")
    await expect(activity).toContainText("user_paused", { timeout: 20_000 })
    await expect(activity).toContainText("User paused")
    await page.keyboard.press("Escape")

    await page.reload({ waitUntil: "domcontentloaded" })

    const restoredCard = page.getByTestId("active-goal-card").filter({ hasText: OBJECTIVE })
    await expect(restoredCard).toHaveCount(1)
    await expect(restoredCard).toContainText("paused")
    await restoredCard.getByTestId("active-card-resume").click()
    await expect(restoredCard).toContainText("active")
    await restoredCard.getByTestId("active-card-stop").click()

    await expect(restoredCard).toHaveCount(0)
    await page.getByTestId("goal-console-tab-history").click()
    const historyRow = page.getByTestId("goals-history-row").filter({ hasText: OBJECTIVE })
    await expect(historyRow).toHaveCount(1)
    await expect(historyRow).toContainText("stopped")
  })
})
