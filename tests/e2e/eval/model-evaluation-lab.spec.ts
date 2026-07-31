/**
 * Browser-owned Evaluation Lab contract.
 *
 * unlocked account / /eval → create the built-in versioned dataset and inspect
 * an intentionally blocked preflight → durable evidence and every responsive
 * shell avoid page-level overflow.
 * Persisted dataset/case rows and the visible preflight issue list are the
 * diagnostics when the journey fails.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"

import { ensureCogniaAccount, readDexieRows } from "../helpers/db-reset"

test.describe("model evaluation lab", () => {
  test("@critical creates reproducible starter evidence and exposes preflight diagnostics", async ({
    page,
  }) => {
    await page.goto("/eval")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/eval", { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("heading", { name: "Model Evaluation Lab" })).toBeVisible()
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
