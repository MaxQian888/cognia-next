/**
 * Browser E2E: portable Scheduler task lifecycle.
 *
 * System tasks and background delivery belong to native suites. This spec owns
 * the renderer scheduler contract: create a real persisted app task through
 * the product form, observe its armed cron schedule, pause it, reload the full
 * document, and resume it from the durable task row.
 */

import { expect, test } from "@playwright/test"
import { ensureCogniaAccount } from "../helpers/db-reset"

const TASK_NAME = "E2E Release Reminder"
const TASK_DESCRIPTION = "Keeps the release checklist visible"

test.describe("scheduler — app task lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/scheduler", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("scheduler-new-task-button")).toBeVisible()
  })

  test("creates, pauses, restores, and resumes an armed app task", async ({ page }) => {
    await page.getByTestId("scheduler-new-task-button").click()

    const form = page.getByTestId("scheduler-task-form")
    await form.getByTestId("scheduler-task-name-input").fill(TASK_NAME)
    await form.getByPlaceholder("Describe what this task does").fill(TASK_DESCRIPTION)
    await form.getByRole("button", { name: "Test / Health Check", exact: true }).click()
    await form.getByTestId("scheduler-task-submit").click()

    await expect(form).toBeHidden()
    const taskRow = page
      .locator('[data-testid^="unified-sidebar-item-app:"]')
      .filter({ hasText: TASK_NAME })
    await expect(taskRow).toHaveCount(1)
    await expect(taskRow).toContainText("0 9 * * *")
    await taskRow.click()

    await expect(page.getByRole("heading", { name: TASK_NAME, level: 2 })).toBeVisible()
    await expect(page.getByText(TASK_DESCRIPTION, { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Pause", exact: true }).click()
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible()

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("scheduler-new-task-button")).toBeVisible()

    const restoredRow = page
      .locator('[data-testid^="unified-sidebar-item-app:"]')
      .filter({ hasText: TASK_NAME })
    await expect(restoredRow).toHaveCount(1)
    await restoredRow.click()

    const resumeButton = page.getByRole("button", { name: "Resume", exact: true })
    await expect(resumeButton).toBeVisible()
    await resumeButton.click()
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible()
  })
})
