/**
 * Browser E2E: unified Agent Runs fan-in and goal action routing.
 *
 * The run is authored through the Goals product, then observed and controlled
 * through /agent-runs. This proves the console consumes the durable goal row,
 * mirrors selection/filter state into the URL, and routes lifecycle actions
 * back to the owning goal runtime.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"

import { ensureCogniaAccount } from "../helpers/db-reset"

const OBJECTIVE = "Audit the release evidence from the unified runs console"

test.describe("agent runs — goal fan-in and control", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/goals", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("goal-console")).toBeVisible()
  })

  test("filters, deep-links, pauses, restores, resumes, and aborts a goal run", async ({
    page,
  }) => {
    const consoleHeader = page.getByTestId("goal-console").locator("header")
    await consoleHeader.getByTestId("goal-quick-create-trigger").click()
    const createDialog = page.getByTestId("goal-quick-create-dialog")
    await createDialog.getByTestId("goal-quick-create-objective").fill(OBJECTIVE)
    await createDialog.getByTestId("goal-quick-create-submit").click()

    await expect(page).toHaveURL(/\/$/)
    await page.goto("/agent-runs?kind=goal", { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("heading", { name: "Agent Runs" })).toBeVisible()

    const goalsTab = page.getByRole("tab", { name: "Goals", exact: true })
    await expect(goalsTab).toHaveAttribute("aria-selected", "true")
    const runRow = page.getByRole("list", { name: "Agent Runs" }).getByRole("button", {
      name: new RegExp(OBJECTIVE),
    })
    await expect(runRow).toContainText("Running")
    await expect(runRow).toContainText("Live")
    await runRow.click()

    await expect(page).toHaveURL(/kind=goal.*run=goal%3A|run=goal%3A.*kind=goal/)
    await expect(page.getByRole("heading", { name: OBJECTIVE, level: 2 })).toBeVisible()
    await expect(page.getByText("Status").locator("..")).toContainText("Running")

    await page.getByRole("button", { name: "Pause", exact: true }).click()
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible()

    await page.reload({ waitUntil: "domcontentloaded" })
    const resumeButton = page.getByRole("button", { name: "Resume", exact: true })
    await expect(resumeButton).toBeVisible()
    await resumeButton.click()
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible()

    await page.getByRole("button", { name: "Abort", exact: true }).click()
    await expect(page.getByText("Status").locator("..")).toContainText("Cancelled")
    await expect(page.getByRole("button", { name: "Abort", exact: true })).toHaveCount(0)
  })
})
