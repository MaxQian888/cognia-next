/**
 * Browser E2E: task-cockpit fan-in and goal control routing.
 *
 * The run is authored through the Goals product, then observed and controlled
 * through /agent-runs. This proves the cockpit consumes the durable run, mirrors
 * selection/filter state into the URL, and drives lifecycle actions through the
 * shared control plane (`executeRunControlCommand`) rather than reaching into
 * the goal runtime directly.
 *
 * The deep-link assertion is load-bearing: `?run=` now carries the EXECUTION RUN
 * id, which is what `run-reducer.ts` stamps into every IM card's `detailsUrl`.
 * The old panel matched a different id space, so those links opened an empty pane.
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

    // Kind is a select now — ten kinds is too many for a tab strip, and the
    // prominent chips belong to the status filter.
    await expect(page.getByLabel("Filter by kind")).toHaveValue("goal")
    const runRow = page.getByRole("list", { name: "Agent Runs" }).getByRole("button", {
      name: new RegExp(OBJECTIVE),
    })
    await expect(runRow).toContainText("Running")
    await expect(runRow).toContainText("Live")
    await runRow.click()

    await expect(page).toHaveURL(/kind=goal.*run=|run=.*kind=goal/)
    await expect(page.getByRole("heading", { name: OBJECTIVE, level: 2 })).toBeVisible()
    await expect(page.getByText("Status").locator("..")).toContainText("Running")

    await page.getByRole("button", { name: "Pause", exact: true }).click()
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible()

    await page.reload({ waitUntil: "domcontentloaded" })
    const resumeButton = page.getByRole("button", { name: "Resume", exact: true })
    await expect(resumeButton).toBeVisible()
    await resumeButton.click()
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible()

    await page.getByRole("button", { name: "Stop", exact: true }).click()
    await expect(page.getByText("Status").locator("..")).toContainText("Cancelled")
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  })
})
