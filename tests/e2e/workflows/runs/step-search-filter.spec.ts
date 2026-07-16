/**
 * E2E: runs list free-text filter narrows the visible rows.
 *
 * An earlier version of this spec claimed to test a "step search" input on
 * /workflows/run — a control that page has never rendered. Its
 * `.or(getByRole("textbox", { name: /search/i }))` fallback resolved to the
 * DESKTOP TITLE BAR's global "Search or run command…" box, so the test
 * green-lit by typing into the command palette. This version drives the real
 * text filter on the runs list (data-testid="runs-search", matching run id /
 * trigger kind) and asserts it actually narrows the result set.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow, seedRun } from "../../helpers/seed-workflow"

test.describe("workflow runs — list text filter", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("free-text filter narrows the run rows to the matching id", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "multi-step")
    const runA = await seedRun(page, wfId, "succeeded")
    const runB = await seedRun(page, wfId, "failed")
    await page.goto(`/workflows/runs?id=${wfId}`)

    const search = page.getByTestId("runs-search")
    await expect(search).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId(`runs-select-${runA}`)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId(`runs-select-${runB}`)).toBeVisible()

    // Filter down to run A by its id — run B must disappear.
    await search.fill(runA)
    await expect(page.getByTestId(`runs-select-${runB}`)).toHaveCount(0)
    await expect(page.getByTestId(`runs-select-${runA}`)).toBeVisible()

    // A no-match query empties the list entirely.
    await search.fill("zzz-no-such-run")
    await expect(page.getByTestId(`runs-select-${runA}`)).toHaveCount(0)
    await expect(page.getByTestId(`runs-select-${runB}`)).toHaveCount(0)
  })
})
