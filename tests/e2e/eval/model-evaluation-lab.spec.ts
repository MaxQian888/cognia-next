/**
 * Browser-owned Evaluation Lab contract.
 *
 * The served build selects the legacy workspace or opt-in Evaluation Lab.
 * Verify the legacy workspace explicitly when the Lab is unavailable; a Lab
 * build must create the built-in versioned dataset and expose blocked preflight
 * diagnostics without responsive page overflow.
 * Persisted dataset/case rows and the visible preflight issue list are the
 * diagnostics when the journey fails.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"

import { resetCogniaDb, readDexieRows } from "../helpers/db-reset"

test.describe("model evaluation lab", () => {
  test("@critical verifies the served eval variant and Lab starter/preflight contract", async ({
    page,
  }) => {
    await page.goto("/eval")
    await resetCogniaDb(page)
    await page.goto("about:blank")
    await page.goto("/eval", { waitUntil: "domcontentloaded" })
    // Observe the served artifact, not the test runner's environment: Next
    // embeds NEXT_PUBLIC_EVAL_LAB at build time and may enable legacy rollback.
    const labHeading = page.getByRole("heading", { name: "Model Evaluation Lab", exact: true })
    const legacyHeading = page.getByRole("heading", { name: "Agent Evaluation", exact: true })
    await expect(labHeading.or(legacyHeading)).toBeVisible()
    if (await legacyHeading.isVisible()) {
      test.info().annotations.push({
        type: "eval-build-variant",
        description: "Legacy workspace verified; this artifact does not enable Evaluation Lab.",
      })
      await expect(page.getByRole("button", { name: "New dataset", exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "Runs & compare", exact: true })).toBeVisible()
      await expect(labHeading).toHaveCount(0)
      await expect(page.getByRole("textbox", { name: "Project name" })).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Preflight", exact: true })).toHaveCount(0)
      await expect(page.getByTestId("eval-lab-mobile-actions")).toHaveCount(0)
      return
    }
    test
      .info()
      .annotations.push({ type: "eval-build-variant", description: "Evaluation Lab enabled" })
    await expect(legacyHeading).toHaveCount(0)
    await page.getByRole("textbox", { name: "Project name" }).fill("E2E model selection")
    await page.getByRole("button", { name: "Data" }).click()
    await page.getByRole("button", { name: "Use starter" }).click()

    await expect(page.getByText("30", { exact: true })).toHaveCount(2)
    await expect
      .poll(async () => ({
        datasets: (await readDexieRows<{ id: string }>(page, { table: "evalDatasets" })).length,
        cases: (await readDexieRows<{ id: string }>(page, { table: "evalCases" })).length,
      }))
      .toEqual({ datasets: 1, cases: 30 })

    await page.getByRole("button", { name: "Preflight" }).click()
    await expect(page.getByText("Dispatch is blocked", { exact: true })).toBeVisible()
    await expect(page.getByTestId("preflight-issue")).not.toHaveCount(0)

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 820, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport)
      await expect
        .poll(() =>
          page.evaluate(() => ({
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
          }))
        )
        .toEqual({ documentWidth: viewport.width, viewportWidth: viewport.width })
    }
    await expect(page.getByTestId("eval-lab-mobile-actions")).toBeVisible()
  })
})
